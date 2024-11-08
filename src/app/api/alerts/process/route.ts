import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';

// Type for the transaction client
type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

// Initialize Prisma with connection pooling settings
const prisma = new PrismaClient({
  log: ['error', 'warn'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL
    }
  },
  // Add connection pooling settings
  __internal: {
    engine: {
      connectionLimit: 1, // Limit concurrent connections
      poolTimeout: 20, // Timeout in seconds
    }
  }
});

const resend = new Resend(process.env.RESEND_API_KEY);

type Listing = {
  title: string;
  company: string;
  location: string;
  link: string;
  datePosted: string;
};

type Criterion = {
  type: 'company' | 'location' | 'keyword';
  value: string;
};

type ProcessResult = {
  email: string;
  matchedListings?: number;
  error?: string;
  success: boolean;
};

export async function GET() {
  // Create a new client for this request
  let localPrisma: PrismaClient | null = null;

  try {
    // Use a new client instance for this request
    localPrisma = new PrismaClient();
    await localPrisma.$connect();

    const result = await localPrisma.$transaction(async (tx: TransactionClient) => {
      const processedResults: ProcessResult[] = [];

      // Use a simple query without prepared statements
      const subscriptions = await tx.$queryRaw`SELECT * FROM "Subscription"`;
      const now = new Date();

      for (const subscription of subscriptions) {
        try {
          const lastNotified = new Date(subscription.lastNotified);

          const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/fetchJobs`);
          if (!response.ok) {
            throw new Error('Failed to fetch jobs');
          }

          const { listings } = await response.json();

          const matchingListings = listings.filter((listing: Listing) => {
            const listingDate = new Date(listing.datePosted);
            if (listingDate <= lastNotified) return false;

            const criteria = subscription.criteria as Criterion[];

            return criteria?.some((criterion: Criterion) => {
              const value = listing[criterion.type === 'keyword' ? 'title' : criterion.type].toLowerCase();
              return value.includes(criterion.value.toLowerCase());
            }) ?? false;
          });

          if (matchingListings.length > 0) {
            await resend.emails.send({
              from: 'Scout <notifications@scout.yourdomain.com>',
              to: subscription.email,
              subject: 'New Job Listings Match Your Criteria',
              html: `
                <h1>New Job Listings</h1>
                <p>We found ${matchingListings.length} new listings matching your criteria:</p>
                ${matchingListings.map((listing: Listing) => `
                  <div style="margin-bottom: 20px;">
                    <h2>${listing.title}</h2>
                    <p><strong>${listing.company}</strong> - ${listing.location}</p>
                    <p><a href="${listing.link}">View Listing</a></p>
                  </div>
                `).join('')}
              `,
            });

            // Use parameterized query instead of prepared statement
            await tx.$executeRaw`
              UPDATE "Subscription" 
              SET "lastNotified" = ${now} 
              WHERE id = ${subscription.id}
            `;

            processedResults.push({
              email: subscription.email,
              matchedListings: matchingListings.length,
              success: true,
            });
          }
        } catch (error) {
          console.error(`Error processing subscription ${subscription.id}:`, error);
          processedResults.push({
            email: subscription.email,
            error: 'Failed to process subscription',
            success: false,
          });
        }
      }

      return processedResults;
    });

    return NextResponse.json({
      success: true,
      processed: result
    });
  } catch (error) {
    console.error('Error processing alerts:', error);
    return NextResponse.json(
      { error: 'Failed to process alerts', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  } finally {
    if (localPrisma) {
      await localPrisma.$disconnect();
    }
  }
}
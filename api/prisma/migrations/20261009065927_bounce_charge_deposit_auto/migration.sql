-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "autoRefunded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PaymentAllocation" ADD COLUMN     "bounce" DECIMAL(12,2) NOT NULL DEFAULT 0;

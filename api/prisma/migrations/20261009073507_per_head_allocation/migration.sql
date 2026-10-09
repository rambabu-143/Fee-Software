-- CreateTable
CREATE TABLE "PaymentAllocationHead" (
    "id" SERIAL NOT NULL,
    "allocationId" INTEGER NOT NULL,
    "feeHeadId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "refundable" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PaymentAllocationHead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAllocationHead_allocationId_idx" ON "PaymentAllocationHead"("allocationId");

-- AddForeignKey
ALTER TABLE "PaymentAllocationHead" ADD CONSTRAINT "PaymentAllocationHead_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "PaymentAllocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

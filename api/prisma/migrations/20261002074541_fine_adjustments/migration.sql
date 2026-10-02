-- CreateTable
CREATE TABLE "FineAdjustment" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "installmentId" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "remarks" TEXT NOT NULL,

    CONSTRAINT "FineAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FineAdjustment_enrollmentId_installmentId_key" ON "FineAdjustment"("enrollmentId", "installmentId");

-- AddForeignKey
ALTER TABLE "FineAdjustment" ADD CONSTRAINT "FineAdjustment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FineAdjustment" ADD CONSTRAINT "FineAdjustment_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'CHEQUE', 'UPI', 'BANK_TRANSFER', 'CARD');

-- CreateTable
CREATE TABLE "Payment" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "yearId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "receiptNo" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "remarks" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" SERIAL NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "installmentId" INTEGER NOT NULL,
    "charges" DECIMAL(12,2) NOT NULL,
    "fine" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "schoolId" INTEGER NOT NULL,
    "yearId" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("schoolId","yearId")
);

-- CreateIndex
CREATE INDEX "Payment_studentId_yearId_idx" ON "Payment"("studentId", "yearId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_schoolId_yearId_receiptNo_key" ON "Payment"("schoolId", "yearId", "receiptNo");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

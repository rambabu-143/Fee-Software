-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('M', 'F', 'OTHER');

-- CreateEnum
CREATE TYPE "SchoolKind" AS ENUM ('SENIOR', 'JUNIOR');

-- CreateEnum
CREATE TYPE "SendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ClearStatus" AS ENUM ('PENDING', 'CLEARED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('TC', 'ADMISSION_CERT');

-- CreateEnum
CREATE TYPE "SubjectKind" AS ENUM ('LANGUAGE', 'ADDITIONAL', 'CORE');

-- CreateEnum
CREATE TYPE "VoucherKind" AS ENUM ('CAUTION_REFUND', 'ADVANCE_REFUND', 'EXCESS_REFUND', 'OTHER');

-- CreateEnum
CREATE TYPE "DepositKind" AS ENUM ('ADVANCE', 'CAUTION', 'TRANSPORT');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('HELD', 'REFUNDED', 'ADJUSTED', 'FORFEITED');

-- DropForeignKey
ALTER TABLE "PaymentAllocation" DROP CONSTRAINT "PaymentAllocation_installmentId_fkey";

-- AlterTable
ALTER TABLE "Concession" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bankDate" DATE,
ADD COLUMN     "bankId" INTEGER,
ADD COLUMN     "bounceCharge" DECIMAL(12,2),
ADD COLUMN     "bouncedAt" TIMESTAMP(3),
ADD COLUMN     "chequeDate" DATE,
ADD COLUMN     "chequeNo" TEXT,
ADD COLUMN     "clearStatus" "ClearStatus" NOT NULL DEFAULT 'CLEARED';

-- AlterTable
ALTER TABLE "PaymentAllocation" ADD COLUMN     "arrear" DECIMAL(12,2) NOT NULL DEFAULT 0,
ALTER COLUMN "installmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "address" TEXT,
ADD COLUMN     "affiliationNo" TEXT,
ADD COLUMN     "kind" "SchoolKind" NOT NULL DEFAULT 'SENIOR',
ADD COLUMN     "schoolNo" TEXT;

-- AlterTable
ALTER TABLE "Section" ADD COLUMN     "classTeacher" TEXT;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "aadhaar" TEXT,
ADD COLUMN     "address" TEXT,
ADD COLUMN     "admissionDate" DATE,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "cbseRegNo" TEXT,
ADD COLUMN     "familyId" INTEGER,
ADD COLUMN     "fatherEmail" TEXT,
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "motherEmail" TEXT,
ADD COLUMN     "nationality" TEXT DEFAULT 'INDIAN',
ADD COLUMN     "penNo" TEXT,
ADD COLUMN     "religion" TEXT;

-- CreateTable
CREATE TABLE "Guardian" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "designation" TEXT,
    "organization" TEXT,
    "officeAddress" TEXT,
    "officePhone" TEXT,
    "occupationId" INTEGER,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "staffBranch" TEXT,

    CONSTRAINT "Guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Occupation" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" INTEGER,

    CONSTRAINT "Occupation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SubjectKind" NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentSubject" (
    "enrollmentId" INTEGER NOT NULL,
    "subjectId" INTEGER NOT NULL,

    CONSTRAINT "StudentSubject_pkey" PRIMARY KEY ("enrollmentId","subjectId")
);

-- CreateTable
CREATE TABLE "IssuedDocument" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "yearId" INTEGER NOT NULL,
    "type" "DocType" NOT NULL,
    "serialNo" INTEGER NOT NULL,
    "issuedOn" DATE NOT NULL,
    "issuedBy" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL,

    CONSTRAINT "IssuedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefaulterLetterTemplate" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "DefaulterLetterTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefaulterNotice" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'FEE',
    "dueAmount" DECIMAL(12,2) NOT NULL,
    "asOf" DATE NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefaulterNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bank" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "accountNo" TEXT,
    "ifsc" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Bank_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "yearId" INTEGER NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "voucherNo" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "kind" "VoucherKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" TEXT,
    "remarks" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherCounter" (
    "schoolId" INTEGER NOT NULL,
    "yearId" INTEGER NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "VoucherCounter_pkey" PRIMARY KEY ("schoolId","yearId")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "kind" "DepositKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "receivedYearId" INTEGER NOT NULL,
    "paymentId" INTEGER,
    "status" "DepositStatus" NOT NULL DEFAULT 'HELD',
    "refundedAt" DATE,
    "refundAmount" DECIMAL(12,2),
    "deduction" DECIMAL(12,2),
    "refundMode" "PaymentMode",
    "refundRef" TEXT,
    "remarks" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArrearCarry" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "fromYearId" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL,
    "waivedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "waiveReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArrearCarry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportRenewal" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "filledBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "TransportRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsTemplate" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "forType" TEXT NOT NULL,
    "starting" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "ending" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SmsTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "enrollmentId" INTEGER,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "SendStatus" NOT NULL,
    "providerResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "enrollmentId" INTEGER,
    "address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "SendStatus" NOT NULL,
    "providerResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER,
    "username" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "schoolId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("schoolId","key")
);

-- CreateIndex
CREATE INDEX "Guardian_studentId_idx" ON "Guardian"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Occupation_schoolId_name_key" ON "Occupation"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_schoolId_name_key" ON "Subject"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedDocument_schoolId_type_yearId_serialNo_key" ON "IssuedDocument"("schoolId", "type", "yearId", "serialNo");

-- CreateIndex
CREATE UNIQUE INDEX "DefaulterLetterTemplate_schoolId_name_key" ON "DefaulterLetterTemplate"("schoolId", "name");

-- CreateIndex
CREATE INDEX "DefaulterNotice_schoolId_enrollmentId_idx" ON "DefaulterNotice"("schoolId", "enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Bank_schoolId_name_key" ON "Bank"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_schoolId_yearId_voucherNo_key" ON "Voucher"("schoolId", "yearId", "voucherNo");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_studentId_kind_key" ON "Deposit"("studentId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ArrearCarry_enrollmentId_key" ON "ArrearCarry"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TransportRenewal_enrollmentId_key" ON "TransportRenewal"("enrollmentId");

-- CreateIndex
CREATE INDEX "SmsTemplate_schoolId_forType_idx" ON "SmsTemplate"("schoolId", "forType");

-- CreateIndex
CREATE INDEX "SmsLog_schoolId_createdAt_idx" ON "SmsLog"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailTemplate_schoolId_idx" ON "EmailTemplate"("schoolId");

-- CreateIndex
CREATE INDEX "EmailLog_schoolId_createdAt_idx" ON "EmailLog"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_schoolId_entity_createdAt_idx" ON "AuditLog"("schoolId", "entity", "createdAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bankId_fkey" FOREIGN KEY ("bankId") REFERENCES "Bank"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardian" ADD CONSTRAINT "Guardian_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardian" ADD CONSTRAINT "Guardian_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Occupation" ADD CONSTRAINT "Occupation_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Occupation" ADD CONSTRAINT "Occupation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Occupation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bank" ADD CONSTRAINT "Bank_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_receivedYearId_fkey" FOREIGN KEY ("receivedYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrearCarry" ADD CONSTRAINT "ArrearCarry_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrearCarry" ADD CONSTRAINT "ArrearCarry_fromYearId_fkey" FOREIGN KEY ("fromYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportRenewal" ADD CONSTRAINT "TransportRenewal_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "FacilityKind" AS ENUM ('TRANSPORT', 'HOSTEL');

-- CreateTable
CREATE TABLE "Facility" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "kind" "FacilityKind" NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityFeeStructure" (
    "id" SERIAL NOT NULL,
    "yearId" INTEGER NOT NULL,
    "facilityId" INTEGER NOT NULL,
    "installmentId" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "FacilityFeeStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacilityAssignment" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "facilityId" INTEGER NOT NULL,

    CONSTRAINT "FacilityAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Facility_schoolId_kind_name_key" ON "Facility"("schoolId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityFeeStructure_yearId_facilityId_installmentId_key" ON "FacilityFeeStructure"("yearId", "facilityId", "installmentId");

-- CreateIndex
CREATE UNIQUE INDEX "FacilityAssignment_enrollmentId_facilityId_key" ON "FacilityAssignment"("enrollmentId", "facilityId");

-- AddForeignKey
ALTER TABLE "Facility" ADD CONSTRAINT "Facility_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityFeeStructure" ADD CONSTRAINT "FacilityFeeStructure_yearId_fkey" FOREIGN KEY ("yearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityFeeStructure" ADD CONSTRAINT "FacilityFeeStructure_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityFeeStructure" ADD CONSTRAINT "FacilityFeeStructure_installmentId_fkey" FOREIGN KEY ("installmentId") REFERENCES "Installment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityAssignment" ADD CONSTRAINT "FacilityAssignment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityAssignment" ADD CONSTRAINT "FacilityAssignment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

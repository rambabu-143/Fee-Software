-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "isNewAdmission" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Installment" ADD COLUMN     "finePerDay" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "_EnrollmentToFeeHead" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_EnrollmentToFeeHead_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_EnrollmentToFeeHead_B_index" ON "_EnrollmentToFeeHead"("B");

-- AddForeignKey
ALTER TABLE "_EnrollmentToFeeHead" ADD CONSTRAINT "_EnrollmentToFeeHead_A_fkey" FOREIGN KEY ("A") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_EnrollmentToFeeHead" ADD CONSTRAINT "_EnrollmentToFeeHead_B_fkey" FOREIGN KEY ("B") REFERENCES "FeeHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

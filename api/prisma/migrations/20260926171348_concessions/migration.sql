-- CreateTable
CREATE TABLE "Concession" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "feeHeadId" INTEGER NOT NULL,
    "percent" DECIMAL(5,2),
    "amount" DECIMAL(12,2),
    "reason" TEXT NOT NULL,

    CONSTRAINT "Concession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Concession_enrollmentId_feeHeadId_key" ON "Concession"("enrollmentId", "feeHeadId");

-- AddForeignKey
ALTER TABLE "Concession" ADD CONSTRAINT "Concession_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Concession" ADD CONSTRAINT "Concession_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FeeHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One of percent / amount, within sane bounds.
ALTER TABLE "Concession" ADD CONSTRAINT "Concession_one_kind" CHECK (
  (percent IS NOT NULL AND amount IS NULL AND percent > 0 AND percent <= 100)
  OR (amount IS NOT NULL AND percent IS NULL AND amount > 0)
);

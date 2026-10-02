-- AlterEnum
ALTER TYPE "FacilityKind" ADD VALUE 'SLAB';

-- CreateTable
CREATE TABLE "Stop" (
    "id" SERIAL NOT NULL,
    "routeId" INTEGER NOT NULL,
    "slabId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "pickupTime" TEXT,
    "dropTime" TEXT,

    CONSTRAINT "Stop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportAssignment" (
    "id" SERIAL NOT NULL,
    "enrollmentId" INTEGER NOT NULL,
    "pickupStopId" INTEGER,
    "dropStopId" INTEGER,

    CONSTRAINT "TransportAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Stop_routeId_sequence_key" ON "Stop"("routeId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Stop_routeId_name_key" ON "Stop"("routeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TransportAssignment_enrollmentId_key" ON "TransportAssignment"("enrollmentId");

-- AddForeignKey
ALTER TABLE "Stop" ADD CONSTRAINT "Stop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stop" ADD CONSTRAINT "Stop_slabId_fkey" FOREIGN KEY ("slabId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAssignment" ADD CONSTRAINT "TransportAssignment_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAssignment" ADD CONSTRAINT "TransportAssignment_pickupStopId_fkey" FOREIGN KEY ("pickupStopId") REFERENCES "Stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAssignment" ADD CONSTRAINT "TransportAssignment_dropStopId_fkey" FOREIGN KEY ("dropStopId") REFERENCES "Stop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "TransportAssignment" DROP CONSTRAINT "TransportAssignment_dropStopId_fkey";

-- DropForeignKey
ALTER TABLE "TransportAssignment" DROP CONSTRAINT "TransportAssignment_pickupStopId_fkey";

-- AddForeignKey
ALTER TABLE "TransportAssignment" ADD CONSTRAINT "TransportAssignment_pickupStopId_fkey" FOREIGN KEY ("pickupStopId") REFERENCES "Stop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAssignment" ADD CONSTRAINT "TransportAssignment_dropStopId_fkey" FOREIGN KEY ("dropStopId") REFERENCES "Stop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

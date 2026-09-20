-- CreateEnum
CREATE TYPE "LayoutItemKind" AS ENUM ('FURNITURE', 'PLANT');

-- CreateTable
CREATE TABLE "BalconyLayout" (
    "id" TEXT NOT NULL,
    "balconyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "widthCm" INTEGER NOT NULL DEFAULT 360,
    "depthCm" INTEGER NOT NULL DEFAULT 240,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalconyLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutItem" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "kind" "LayoutItemKind" NOT NULL,
    "name" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "w" DOUBLE PRECISION NOT NULL,
    "h" DOUBLE PRECISION NOT NULL,
    "clearanceCm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "plantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LayoutItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutRevision" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "beforeJson" JSONB NOT NULL,
    "afterJson" JSONB NOT NULL,
    "undone" BOOLEAN NOT NULL DEFAULT false,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LayoutRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BalconyLayout_balconyId_key" ON "BalconyLayout"("balconyId");

-- CreateIndex
CREATE INDEX "LayoutItem_layoutId_sortOrder_idx" ON "LayoutItem"("layoutId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutRevision_layoutId_seq_key" ON "LayoutRevision"("layoutId", "seq");

-- CreateIndex
CREATE INDEX "LayoutRevision_layoutId_undone_idx" ON "LayoutRevision"("layoutId", "undone");

-- AddForeignKey
ALTER TABLE "BalconyLayout" ADD CONSTRAINT "BalconyLayout_balconyId_fkey" FOREIGN KEY ("balconyId") REFERENCES "Balcony"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutItem" ADD CONSTRAINT "LayoutItem_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "BalconyLayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutRevision" ADD CONSTRAINT "LayoutRevision_layoutId_fkey" FOREIGN KEY ("layoutId") REFERENCES "BalconyLayout"("id") ON DELETE CASCADE ON UPDATE CASCADE;

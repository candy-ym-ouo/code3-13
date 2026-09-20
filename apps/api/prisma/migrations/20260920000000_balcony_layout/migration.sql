-- 阳台布局规划：阳台尺寸 + 乐观并发版本，位置精确几何与层叠顺序
ALTER TABLE "Balcony" ADD COLUMN "widthCm" INTEGER;
ALTER TABLE "Balcony" ADD COLUMN "depthCm" INTEGER;
ALTER TABLE "Balcony" ADD COLUMN "layoutVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Zone" ADD COLUMN "xCm" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "yCm" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "widthCm" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "depthCm" INTEGER;
ALTER TABLE "Zone" ADD COLUMN "zIndex" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Zone_balconyId_zIndex_idx" ON "Zone"("balconyId", "zIndex");

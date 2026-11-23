-- CreateTable
CREATE TABLE "MlModel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "dataSourceId" TEXT,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "sql" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "bundle" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MlModel_workspaceId_createdAt_idx" ON "MlModel"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "MlModel" ADD CONSTRAINT "MlModel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlModel" ADD CONSTRAINT "MlModel_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MlModel" ADD CONSTRAINT "MlModel_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

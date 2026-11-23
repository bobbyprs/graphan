-- CreateTable
CREATE TABLE "DataModel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "joins" JSONB NOT NULL DEFAULT '[]',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataModel_dataSourceId_key" ON "DataModel"("dataSourceId");

-- CreateIndex
CREATE INDEX "DataModel_workspaceId_idx" ON "DataModel"("workspaceId");

-- AddForeignKey
ALTER TABLE "DataModel" ADD CONSTRAINT "DataModel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataModel" ADD CONSTRAINT "DataModel_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

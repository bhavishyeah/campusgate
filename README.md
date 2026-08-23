# CAMPUSGATE

> Digital Campus Entry & Exit Management System

CAMPUSGATE V1 digitally authorizes and records temporary student campus exits through a controlled **Student → HOD → Guard** workflow.

## Tech Stack

- **Frontend:** Next.js 15 (App Router) + TypeScript + Tailwind CSS
- **Backend:** Fastify + TypeScript
- **Database:** PostgreSQL + Prisma ORM
- **Real-time:** WebSocket (native)
- **Auth:** JWT + Google OAuth (planned)
- **Monorepo:** Turborepo + npm workspaces
- **PWA:** manifest + service worker ready

## Project Structure

```
campusgate/
├── apps/
│   ├── web/          # Next.js frontend (Student, HOD, Guard, Admin)
│   └── api/          # Fastify backend API
├── packages/
│   ├── db/           # Prisma schema, client, seed
│   └── shared/       # Shared types, validation, constants
├── docker-compose.yml
└── turbo.json
```

## Getting Started

### Prerequisites

- Node.js >= 20
- Docker (for PostgreSQL) or a PostgreSQL instance
- npm >= 9

### 1. Install Dependencies

```bash
npm install
```

### 2. Start PostgreSQL

```bash
docker compose up -d
```

### 3. Configure Environment

```bash
# Copy env files
cp packages/db/.env.example packages/db/.env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

### 4. Setup Database

```bash
# Generate Prisma client
npm run db:generate

# Push schema to database
npm run db:push

# Seed with demo data
cd packages/db && npx tsx src/seed.ts
```

### 5. Start Development

```bash
npm run dev
```

- **Frontend:** http://localhost:3000
- **API:** http://localhost:4000
- **API Health:** http://localhost:4000/api/health

### Demo Credentials

| Role    | Email              | Password   |
|---------|--------------------|------------|
| Admin   | admin@demo.edu     | admin123   |
| HOD     | hod.bca@demo.edu   | hod123     |
| Guard   | guard@demo.edu     | guard123   |
| Student | bhavishya@demo.edu | student123 |

## Core Workflow

```
Student submits request → HOD approves → QR generated
→ Guard scans QR → Backend verifies → Guard marks EXIT
→ Student returns → Guard scans → Guard marks RETURN
→ Movement COMPLETED
```

## Architecture Principles

- Backend is the single source of truth
- QR is a reference token, not the authorization
- State machine enforces legal transitions only
- Transactions prevent concurrent duplicate events
- Role-based access enforced at API level
- Timestamps always server-controlled

## License

Private - All rights reserved.

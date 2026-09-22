# ADR-0008: Drizzle for data access, services as the boundary, REST for external clients

**Status:** Accepted
**Date:** 2026-09-17
**Decider:** Rafi (proposed by Claude)

## Context

DealZ starts as a Next.js web app on Supabase Postgres, but the backend should later serve an iOS app and other clients. Three choices were entangled: which library talks to Postgres, where business logic lives, and what boundary clients talk to. The first draft named the REST API as the boundary and the Next.js pages as its first client, which would have had server components fetching their own route handlers.

## Decision

1. Drizzle defines the schema (`src/db/schema.ts`) and generates migrations. Only `src/db` imports it.
2. Business logic lives in `src/services/` as functions over the db layer. The service layer is the boundary.
3. Server components and server actions call services directly. Versioned REST route handlers (`app/api/v1/`) are thin adapters over the same services, added when a consumer needs them. iOS is the first consumer of the REST routes.

## Options rejected

| Data access | Why not |
|---|---|
| Raw SQL with supabase-js | Built for browser-direct access; a mobile client would duplicate business logic per platform |
| Prisma | Hides SQL and needs side files for Postgres-specific parts such as triggers |
| Drizzle (chosen) | One source of truth in TypeScript, readable SQL, full Postgres features |

| Client boundary | Why not |
|---|---|
| Browser-direct database access through supabase-js and RLS | Logic duplicated per platform; not platform-neutral |
| tRPC | Excellent for web, poor from Swift |
| REST as the boundary for the web app too | Server components would fetch their own routes, losing type safety and adding a network hop |
| Services as the boundary, REST for external clients (chosen) | Platform-neutral where it matters, direct where it does not |

## Consequences

- Easier: adding an iOS client is a matter of consuming the existing routes; swapping the ORM is invisible to clients.
- Harder: the web app cannot query the database from client components. Every read goes through a server component or a route handler that calls a service.
- Revisit: if web type ergonomics become painful, tRPC can sit alongside REST for the web only.

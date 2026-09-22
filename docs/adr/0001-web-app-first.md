# ADR-0001: Web app first, iOS later if at all

**Status:** Accepted
**Date:** 2026-09-15
**Decider:** Rafi

## Context

DealZ needs a first client. The candidates were a web app and a native iOS app. The project is a portfolio piece first, so the first client has to be easy for a stranger to open and easy to iterate on alone.

## Decision

The first client is a Next.js web app. iOS is a possible later client, not a commitment. The backend is built so that adding it is a matter of consuming an existing API (ADR-0008).

## Options rejected

- **iOS first.** App Store review and a device requirement stand between a reviewer and the product. Swift also diverges from the web stack the rest of the project teaches.
- **Web and iOS together.** Two surfaces before there is any data to show.

## Consequences

- The data layer and services are the asset; the web app is one view over them.
- Business logic stays out of the client so a second client does not duplicate it.

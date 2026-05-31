# Next.js — Known Anti-Patterns

Seed list for `type: nextjs` repos.

## Server vs client components

- `"use client"` at the top of a file opts it into client rendering — forgetting it on a component that uses `useState` / `useEffect` causes hydration errors only at render time.
- Server components can't import client components transparently — you need a client boundary component. Hooks at the wrong boundary silently break.

## Data fetching

- `fetch` in server components is deduplicated across the render tree — take advantage, don't re-pass results through props you don't need.
- `cache: 'no-store'` vs `revalidate: 60` vs static — default behavior changed across Next versions; pin explicitly for correctness.

## Route handlers

- `app/api/.../route.ts` exports `GET`/`POST`/etc. as functions — missing one means the method returns 405.
- `Request.json()` is async — await it, don't treat it as sync.

## i18n

- App Router's built-in i18n is simpler than Pages Router's — don't mix patterns.
- RTL requires a separate layout per locale direction, not just a string flag.

## Middleware

- `middleware.ts` runs on EVERY request including assets unless `matcher` is specified — without it, every static fetch triggers middleware overhead.
- Cookies set in middleware require the response to be returned from middleware — common foot-gun.

## Caching

- `generateStaticParams` + dynamic routes = static generation. Forgetting `dynamic = 'force-dynamic'` on routes that read live data produces silently-stale pages.

# React (Vite/SWC, TanStack Query, shadcn/ui) — Known Anti-Patterns

Seed list for `type: react` repos. Task-file generator selects relevant subset.

## useCallback / dependency stability

- Depending on a whole hook-return object (`[pagination]`, `[filter]`) is almost always a bug — those objects are recreated every render. Depend on the stable member (`pagination.resetPage`, `filter.clear`) that is itself wrapped in `useCallback([])`.
- The `useTableFilter` / `useTablePagination` contract in this repo family explicitly documents stable-member extraction. Violating it makes `onFilterChange` callbacks trigger on every render.

## URL-persisted filter state

- When `useSearchParams` is used for filter state, EVERY filter parameter documented in the task must be read on mount and written on change. Silent omission of one parameter (e.g., `sort`) means share-links and refreshes lose state.
- React Query cache keys must include all filter params — otherwise stale data surfaces across filter changes.

## i18n / RTL

- Every user-facing string must come from `t('namespace.key')` — no inline English, no inline Arabic. Missing translations show as the key path to end users.
- Use logical properties: `me-*/ms-*`, `ps-*/pe-*`, `start-*/end-*`. Physical `mr-*/ml-*/left-*/right-*` break RTL layout.
- UUID, email, and numeric ID spans need `dir="ltr"` to prevent bidirectional reordering in RTL. Dates use locale-aware formatters.
- Direction-sensitive icons (`ArrowLeft/ArrowRight`, chevrons) should be chosen based on `isRTL`, not hardcoded.

## Pagination shape

- Spec-driven shape `{data, totalElements, totalPages, page, size}` vs legacy `{pagination: {page, pageSize, totalItems, totalPages}}`. Mixing them in one feature is common when reusing old hooks — types won't match the spec-generated ones.

## Role gates

- Client-side `useRoles()` redirects are UX convenience, not security. Backend must enforce every role gate too; otherwise a curl call bypasses the guard.
- If the repo has a `/403` forbidden page, use it. Otherwise the "hide the button + redirect to /" pattern is common but less good UX.

## Download / binary responses

- `responseType: 'blob'` must be set on the service call, not inferred. Without it, Axios/fetch parses the PDF as JSON and chokes.
- Blob URL + imperative `<a download>` + `URL.revokeObjectURL` cleanup is the standard pattern. A `window.open` variant may fail in strict popup-blocker contexts.
- 401 mid-download needs explicit handling — the auth interceptor may not cover binary responses the same way it covers JSON.

## Design system adherence (shadcn/ui + Radix)

- `<Select>` is single-value only; multi-select requires `<Popover>` + `<Checkbox>` composition. Reaching for `<Select multi>` is a smell.
- `<Tooltip>` must wrap the focusable element directly (the button), not a parent span. `pointer-events-none` on a button blocks tooltip activation on keyboard focus.
- `aria-disabled="true"` on an otherwise-focusable button must be paired with `aria-describedby` pointing at the tooltip content; otherwise screen-reader users reach it with no announcement.
- Avoid `Sheet` for read-only detail — the repo pattern favors `Dialog` (actions) or full-route (read-only with shareable URLs).
- Use `createActionsColumn` from `column-helpers` for row actions — never inline icon buttons in table cells.

## React Query cache keys

- Filter changes must invalidate. Put every filter param in the query key; otherwise `useQuery({ queryKey: ['contracts'], ... })` serves stale data when the user changes filters.
- Across user logout/login, clear the cache explicitly — stale user-scoped data can leak.

## Storybook coverage

- Every status badge / color / layout variant needs its own story. Partial coverage (EN only; missing AR variants) defeats visual regression.
- Story decorators that call global `i18n.changeLanguage("ar")` leak across stories — use a scoped `I18nextProvider` with a fresh i18n instance per story.

## TypeScript / spec alignment

- Types generated from spec must not be renamed or "cleaned up" in feature code — downstream generators and diff-aware tools key off the exact shape.
- `strictNullChecks: false` / `noImplicitAny: false` may be relaxed platform-wide; don't let new code expand `any` usage beyond existing patterns.

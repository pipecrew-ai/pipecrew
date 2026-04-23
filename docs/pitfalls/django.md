# Django — Known Pitfalls

Seed list for `type: django` repos.

## App wiring

- A new app's migrations only run after the app is listed in `settings.INSTALLED_APPS`. Easy to forget when creating an app for a feature.
- A new app's `urls.py` must be `include()`'d from the project root's `urls.py` (or an intermediate router). Unreferenced URL patterns are dead code.
- Signals in `{app}/signals.py` only connect if imported — typically via `{app}/apps.py` `ready()` method. A signal file that exists but isn't connected runs in no environment.

## Migrations

- `makemigrations` autogenerate misses: `on_delete` changes (silent no-op), default values for existing rows on new NOT NULL columns, index renames, and custom constraints. Always review the generated file and edit by hand where needed.
- When adding a NOT NULL column to a table with existing rows, split into two migrations: (1) add nullable + backfill, (2) alter to NOT NULL. A single migration fails on a populated table.
- `RunPython` migrations need a reverse function (even a no-op `reverse_code`) — otherwise `migrate --backwards` fails when you need to undo during development.

## DRF serializers + spec

- `source='other_field'` renames the outgoing JSON key — easy to drift from the OpenAPI spec. Compare serializer output to spec after every change.
- `SerializerMethodField` needs `@extend_schema_field(...)` from drf-spectacular or the generated OpenAPI types are `Any`/`null` and spec compliance breaks silently.
- `read_only_fields = [...]` must include every field that should not be writable — missing one means clients can inject values you don't expect.

## Permissions

- DRF permissions: `has_permission` runs on list/create; `has_object_permission` runs on retrieve/update/delete. A custom permission that only implements one of them leaves the other endpoint unprotected.
- `GenericAPIView.get_object()` calls `check_object_permissions()` — overriding `get_object()` without `super()` silently skips object-level permissions.
- `permission_classes = [IsAuthenticated & CanEditBook]` uses DRF's logical composition (requires DRF 3.9+). Using `[IsAuthenticated, CanEditBook]` applies AND by default — the composition form is explicit but differs from the list form only if you mix `OR` / `NOT`.

## Querysets + ORM

- Class-level `queryset = Model.objects.filter(...)` is evaluated at import time. For request-dependent filters, override `get_queryset()`.
- N+1 queries: `Book.objects.all()` followed by `for book in books: print(book.author.name)` fires one query per book. Use `select_related('author')` (FK) or `prefetch_related('tags')` (M2M/reverse FK).
- `.count()` on a queryset fires a SQL COUNT — cheaper than `len(list(qs))` for large querysets. Use `.exists()` for presence checks.

## Transactions

- `@transaction.atomic` wraps a block in a transaction. Nested `atomic` uses savepoints — a raised exception in the inner block rolls back to the savepoint, NOT the outer transaction, unless the exception escapes the outer block too.
- Post-commit hooks: `transaction.on_commit(lambda: ...)` runs after the outer transaction commits; critical for kicking off Celery tasks that need the row to exist.

## Auth / Role

- `request.user` is an `AnonymousUser` for unauthenticated requests — not `None`. Use `request.user.is_authenticated` for the check.
- Custom user models must be set in `AUTH_USER_MODEL` BEFORE the first migration; changing it later is painful.

## Testing

- `APITestCase` wraps each test in a transaction and rolls back — fast, but migrations run once per test class. `TransactionTestCase` truncates tables between tests — slower but needed for tests that rely on DB constraints triggered at COMMIT.
- `override_settings` only works for settings loaded lazily; some settings (DATABASES, INSTALLED_APPS) can't be overridden at test time.
- `pytest-django` fixtures (`db`, `transactional_db`, `django_db_setup`) are not interchangeable — mixing them causes "Database access not allowed" errors.

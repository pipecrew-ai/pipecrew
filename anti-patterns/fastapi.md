# FastAPI — Known Anti-Patterns

Seed list for `type: fastapi` repos.

## Pydantic v1 vs v2

- V2 renames: `Config` class → `model_config`, `dict()` → `model_dump()`, `parse_obj()` → `model_validate()`. Mixing v1 imports with v2 code causes cryptic `AttributeError`s.
- `response_model=Model` validates the outgoing payload; missing it means extra fields leak to clients.

## Dependency injection

- `Depends(...)` caches within a request by default — useful for auth, surprising for DB sessions. Use `Depends(get_db)` with a yield-based generator for proper session lifecycle.
- Global dependencies (`app.include_router(..., dependencies=[Depends(auth)])`) apply to every route in the router — easy to forget and accidentally gate public endpoints.

## Async / await

- A sync DB call (e.g., raw SQLAlchemy session without async engine) inside an `async def` endpoint blocks the event loop. Either use `run_in_threadpool` or commit to full async (`AsyncSession`).
- Mixing `asyncio.gather` with blocking libraries serializes silently — benchmark before claiming parallelism.

## Role / auth

- OAuth2PasswordBearer and HTTPBearer are convenient but easy to misuse — `Depends(oauth2_scheme)` validates the token is PRESENT, not that it's valid. Actual validation happens in your `get_current_user` function; verify it's always the outer dependency.
- Role checks belong in a dedicated `RoleChecker(Depends(get_current_user))` dependency, not ad-hoc `if user.role == ...` inside endpoints.

## Alembic migrations

- Auto-generated migrations often miss: nullable changes, constraint name changes, index changes. Review every migration by hand.
- `op.execute` for raw SQL is needed for CHECK constraints, trigger changes — Alembic doesn't generate these.

## OpenAPI / typing

- `response_model_exclude_none=True` drops null fields — clients that expected them in the shape break silently.
- Path parameters are strings by default; use typed params (`user_id: UUID`) so FastAPI validates format.

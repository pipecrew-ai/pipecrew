# Flask — Known Anti-Patterns

Seed list for `type: flask` repos.

## App factory + blueprint registration

- New blueprints must be `app.register_blueprint(bp, url_prefix="...")` inside the app factory. A blueprint that exists but isn't registered runs in no environment and produces no error.
- `from myapp import app` at module load time breaks with the app-factory pattern — use `current_app` inside blueprints and `app.app_context()` in tests/CLI.
- Extension init order matters — `db.init_app(app)` must come before any model that uses `db.Model`.

## Exception → HTTP status convention

- `abort(404)` raises `werkzeug.exceptions.NotFound` — you can also raise it directly. Mixing `abort()` and custom exceptions with no error handler produces inconsistent response shapes.
- Custom business exceptions need a registered `@app.errorhandler(MyException)` in the app factory, otherwise they hit the default 500 handler.

## Schema / validation library

- marshmallow: `@post_load` is where you turn raw dicts into domain objects; `dump()` produces the JSON-safe shape. Do not mix `@post_load` with Pydantic or attrs serializers in the same project — pick one and stay consistent with the repo.
- Field-level validation via `validate=` on a marshmallow field runs BEFORE `@validates_schema` — if you need cross-field checks, use the schema-level hook.

## SQLAlchemy session scope

- Flask-SQLAlchemy's default session is request-scoped. Outside a request (e.g., background task, CLI command), push an app context or the session is unbound.
- `db.session.commit()` must happen before returning from the view — failing to commit leaves the transaction open and Flask-SQLAlchemy's teardown rolls it back.

## Migrations (Alembic / Flask-Migrate)

- `alembic heads` must show exactly one head. If it shows two, merge with `alembic merge heads -m "merge"` before continuing.
- Autogenerate misses CHECK constraints, nullable→NOT NULL on existing rows (needs a default backfill), and index renames. Review every migration file by hand.

## Role / authz

- `@login_required` from Flask-Login validates a user is logged in — NOT that they have any specific role. Wrap with a custom decorator for role checks.
- CSRF protection from Flask-WTF is per-form; pure-API endpoints need to explicitly exempt (`@csrf.exempt`) or use a token scheme — forgetting this blocks legitimate POSTs.

## JSON encoding custom types

- UUIDs, datetimes, Enum values, and Decimals don't serialize by default. Set `app.json.default = ...` or use a consistent serialization library across the codebase.

## Testing

- `pytest-flask`'s `client` fixture creates a test client from the app factory — if your tests import the app directly, you bypass the fixture and get stale app state between tests.
- `app.test_client()` does NOT push an app context automatically — you often need `with app.app_context():` around DB setup in tests.

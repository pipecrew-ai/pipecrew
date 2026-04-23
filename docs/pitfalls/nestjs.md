# NestJS — Known Pitfalls

Seed list for `type: nestjs` repos.

## DI / provider scope

- Request-scoped providers (`@Injectable({ scope: Scope.REQUEST })`) can't be injected into singletons — causes silent runtime `Cannot resolve dependency` errors only when the request path is hit.
- Circular module imports crash on startup — use `forwardRef(() => OtherModule)` explicitly.

## Guards vs interceptors vs filters

- Role guard at the controller level does NOT run for exception paths — if the exception filter bypasses auth context, logs / responses can leak.
- `@UseGuards(RolesGuard)` must be combined with `@Roles(...)` metadata decorators — missing the metadata means guard sees empty role set and allows/denies unexpectedly.

## TypeORM / migrations

- Migrations must be checked in and run before the new entity schema is relied on. `synchronize: true` in non-dev is a foot-gun.
- Column type in entity decorator must match the migration SQL exactly — mismatch causes runtime type errors on writes.

## Validation pipes

- `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` rejects unexpected fields — essential for keeping the spec honest. Missing it means clients can send garbage that passes validation.
- `class-validator` decorators are compile-time; runtime requires `@nestjs/class-validator` metadata emitted by `reflect-metadata` + `experimentalDecorators: true`.

## Swagger / OpenAPI

- Controller method signatures must be decorated with `@ApiOperation`, `@ApiResponse`, `@ApiQuery` — missing decorators produce a spec that doesn't match reality.
- DTOs need `@ApiProperty` on every field visible to clients.

## Exception mapping

- Default `HttpException` subclasses (`NotFoundException` → 404, `ForbiddenException` → 403) map correctly. Custom exceptions without a status tell Nest to return 500.
- `ValidationPipe` errors return 400 with a verbose details payload — confirm clients handle the shape.

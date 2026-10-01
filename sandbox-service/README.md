# Learning OS SQL sandbox service

This service runs PGlite outside Supabase Edge Functions. It accepts authenticated internal requests from Edge Functions, starts a fresh worker process for each database job, and serializes jobs so only one PGlite instance consumes memory at a time. The worker exits after every job to release its WebAssembly allocation.

## Local run

From the repository root in PowerShell:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:SANDBOX_SERVICE_TOKEN = [Convert]::ToBase64String($bytes)
$env:PORT = '8080'
npm run sandbox:dev
```

The local service health endpoint is `http://127.0.0.1:8080/health`. The token must also be configured as `SANDBOX_SERVICE_TOKEN` in Supabase Edge Function secrets. Hosted Supabase Functions cannot call a service running only on your computer; deploy this Dockerfile to a reachable private service first and set its HTTPS URL as `SANDBOX_SERVICE_URL` in Supabase secrets.

## Container deployment

Build from the repository root so the Dockerfile context includes `sandbox-service/`:

```powershell
docker build -f sandbox-service/Dockerfile -t learning-os-sandbox .
docker run --rm -p 8080:8080 -e SANDBOX_SERVICE_TOKEN="your-random-token" learning-os-sandbox
```

Allocate at least 1 GiB of RAM to the service. The parent queues jobs and each worker may use several hundred MiB. Keep the service private to Supabase Functions where possible; the bearer token is required regardless.

Configure these Supabase Function secrets after deploying the service:

- `SANDBOX_SERVICE_URL`: its HTTPS origin, without a route suffix
- `SANDBOX_SERVICE_TOKEN`: the same random token configured on the service

Set them from the repository root in PowerShell:

```powershell
npx supabase secrets set SANDBOX_SERVICE_URL="https://your-sandbox-host" SANDBOX_SERVICE_TOKEN="same-random-token"
```

Then deploy all functions that import the shared platform module:

```powershell
npx supabase functions deploy save-schema
npx supabase functions deploy generate-schema
npx supabase functions deploy generate-questions
npx supabase functions deploy generate-hint
npx supabase functions deploy run-query
```

Never expose this token in frontend environment variables or send it in chat. Do not deploy the updated Edge Functions until the sandbox service is reachable over HTTPS and both secrets are set.

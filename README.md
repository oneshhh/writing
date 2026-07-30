# Real Write

Real Write is a self-hosted editorial operations platform for writing agencies, content studios, and internal publishing teams. It combines project intake, writer assignment, article review, payments, calendar planning, messaging, and export workflows in one application.

The repository is designed so another team can clone it, connect their own Supabase and PostgreSQL environment, create the first admin account, and run the product on their own infrastructure.

## What The Application Does

Real Write helps writing teams manage the full article lifecycle:

- Admins manage the workspace, users, projects, and payment oversight.
- Managers create projects, invite writers, issue article requests, review submissions, approve or reject drafts, track due dates, and communicate with contributors.
- Writers receive assignments, submit articles, use the built-in editor, follow deadlines on the calendar, and review payment history.

## Core Features

- Multi-role workspace with separate admin, manager, and writer experiences
- Project creation and writer assignment
- Article submission and editorial review queue
- Manager notes, approval/rework states, and export workflows
- Payment tracking and proof uploads
- Shared calendar with request deadlines and notes
- Internal project and person-to-person messaging
- Optional AI detection via Hugging Face
- Built-in plagiarism similarity checks against articles already stored in the workspace
- First-run setup flow for configuration, schema bootstrap, and admin creation

## Architecture

- `backend/`: Express application, API routes, setup/bootstrap logic, exports, and integrations
- `frontend/`: source HTML/CSS/JS for the static UI
- `backend/public/`: deployable static copy used by the backend server and production hosting

The current implementation is built around:

- Supabase Auth for sign-in and session handling
- Supabase Storage for uploaded payment proof files
- PostgreSQL for application tables

## Supported Deployment Model

This codebase currently supports:

- Hosted Supabase
- Self-hosted Supabase
- Local Supabase or PostgreSQL-based development setups

Important limitation:

- This is not a generic multi-database application yet. It is built for Supabase plus PostgreSQL. MySQL, MariaDB, SQLite, and other database engines are not wired in as interchangeable backends.

That means an adopter should bring:

- Their own Supabase project or self-hosted Supabase stack
- A PostgreSQL connection for the application schema
- An optional Hugging Face token if they want hosted AI detection

## First-Run Bootstrap

The application now supports a first-run setup experience.

On startup, if valid database and Supabase credentials are available, the backend can:

- Create the required application tables automatically
- Ensure the `payment-proofs` storage bucket exists
- Create the first admin account from bootstrap environment variables

If credentials are not fully configured yet, the app sends the user to `/setup.html`, where they can:

- Enter the application URL and CORS origins
- Connect their own Supabase project
- Provide PostgreSQL connection details
- Optionally configure AI detection
- Create the first admin account

## Requirements

- Node.js 18 or newer
- A Supabase project or self-hosted Supabase stack
- PostgreSQL credentials for the target database

## Installation

1. Clone the repository.
2. Install backend dependencies:

```bash
npm --prefix backend install
```

3. Choose one of these setup styles:

- Environment-first deployment: configure `backend/.env` from `backend/.env.example`
- UI-first deployment: start the server first and complete `/setup.html`

4. Start the backend:

```bash
npm --prefix backend start
```

5. Open the app in your browser:

- Local default: `http://localhost:3000`
- First-run setup page: `http://localhost:3000/setup.html`

## Environment Variables

Copy `backend/.env.example` to `backend/.env` if you want to manage configuration directly through environment variables.

### Required

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Public anon key
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key used by the backend
- `DATABASE_URL`: Full PostgreSQL connection string

Or, instead of `DATABASE_URL`, provide all of:

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

### Recommended

- `APP_NAME`: Workspace name shown in setup/bootstrap-related flows
- `APP_URL`: Public application URL
- `CORS_ORIGINS`: Comma-separated allowed origins
- `SUPABASE_JWT_AUD`: Usually `authenticated`

### Optional

- `DB_SSL`: `true`, `false`, or `require`
- `HUGGINGFACE_API_TOKEN`: Enables hosted AI detection
- `AI_DETECTOR_MODEL`: Override the default Hugging Face model
- `DEPLOY_TOKEN`: Optional deploy route protection

### Optional Admin Bootstrap

If you want the first admin account created automatically during startup, set:

- `BOOTSTRAP_ADMIN_FULL_NAME`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`

## Setup UI And Secret Storage

The setup page can save configuration into:

- `backend/.runtime-config.json`

This is useful for local installation and simpler self-hosting, but it contains secrets. The file is ignored by Git and should remain private to the deployment server.

For production environments, environment variables are the safer long-term option.

## How To Run It For A Writing Agency

### 1. Create The Workspace

- Connect your Supabase and PostgreSQL environment
- Create the first admin account
- Sign in as the admin

### 2. Create The Team

- Add managers and writers
- Assign the correct role for each person
- Keep inactive users disabled rather than deleting historical ownership

### 3. Organize Projects

- Create a project for each client, brand, or publication stream
- Assign managers to oversee delivery
- Add writers to the relevant project rooms

### 4. Manage Editorial Requests

- Managers create requests and deadlines
- Writers can see their work pipeline
- Calendar pages surface due dates and planning notes

### 5. Review Submissions

- Writers submit drafts through the editor flow
- Managers review submissions from the queue
- Approve, request rework, or export the final article

### 6. Track Payments

- Mark articles or requests as paid
- Upload and store payment proof documents
- Give writers a transparent payment history

### 7. Use Messaging And Calendar Tools

- Messaging supports project coordination and direct communication
- Calendar views give managers and writers a shared schedule of approvals, requests, and notes

## AI Detection And Plagiarism

AI detection is optional.

- If a Hugging Face token is configured, the backend will use the configured model
- If no token is available or the hosted model fails, the app falls back to a heuristic check

Plagiarism checking is also optional from an operations perspective.

- It does not require a separate third-party plagiarism service
- It compares submitted work against articles already stored in the application database

## Database Bootstrap Behavior

On startup, the backend ensures the application schema exists when valid database credentials are available. This makes a fresh deployment easier because adopters do not need to run the full core schema by hand before first use.

The automatic bootstrap creates the tables the application depends on, including:

- users
- projects
- project managers and writer mappings
- project requests
- articles
- payments
- notifications
- calendar notes
- encrypted messages

## Deployment Notes

- The simplest deployment is to run the Express server and serve the static UI from the same host
- You can deploy behind Nginx, Caddy, PM2, Docker, or another Node-compatible process manager
- If you host behind HTTPS in production, keep `APP_URL` and `CORS_ORIGINS` aligned with the public origin
- Protect the `backend/.runtime-config.json` file if you use the setup page in production

## Repository Structure

```text
backend/
  db/
  middleware/
  public/
  routes/
  services/
  utils/
frontend/
  admin/
  assets/
  manager/
  shared/
  writer/
```

## Development Notes

- `frontend/` is the editable source for the UI
- `backend/public/` is the deployable static copy used by the backend
- When updating shared UI pages, keep the deployable `backend/public/` copy in sync

## Known Scope Boundary

This repository is ready to be open-sourced for teams that want a Supabase plus PostgreSQL editorial operations app.

If you later want true bring-your-own-database support across multiple engines, that would require a deeper abstraction layer across:

- authentication
- storage
- data access
- schema migrations
- background integrations

## Publishing Recommendation

Before making the repository public, review:

- any existing real project data
- any checked-in secrets or API keys
- branding text you may want to rename
- your chosen open-source license

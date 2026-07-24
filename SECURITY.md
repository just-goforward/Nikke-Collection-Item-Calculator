# Security Policy

## Supported Versions

This project is a continuously deployed web application. Security fixes are
provided for the latest version on the `main` branch and the current production
deployment only. Older commits, forks, local builds, and archived deployment
artifacts are not maintained.

## Reporting a Vulnerability

Do not open a public issue for a suspected security vulnerability.

Use GitHub's private vulnerability reporting form:

https://github.com/just-goforward/Nikke-Collection-Item-Calculator/security/advisories/new

Include the following information when available:

- affected page, endpoint, or component
- steps required to reproduce the issue
- expected and observed behavior
- browser, operating system, and device type
- whether production, staging, or a local build is affected
- a minimal proof of concept that does not expose real credentials or user data
- the potential impact and any suggested mitigation

You should receive an initial response within 7 days. Please allow reasonable
time for investigation and remediation before public disclosure.

## Security Scope

Examples of issues that should be reported privately include:

- unauthorized access to the private solver diagnostics endpoint
- exposure or modification of Cloudflare D1 data
- bypasses of Turnstile, origin checks, event validation, deduplication, or rate
  limits that materially affect service integrity
- cross-site scripting or unintended script execution
- leakage of Worker secrets, administrator tokens, or deployment credentials
- dependency or build-pipeline vulnerabilities that can affect the deployed
  application
- denial-of-service paths that can materially exhaust Worker, browser, or solver
  resources with ordinary remote requests

The following are normally not security vulnerabilities and should use a regular
issue instead:

- solver recommendation or probability disagreements without a security impact
- visual, responsive-layout, translation, or accessibility defects
- unsupported browsers, extensions, modified clients, or local environment
  problems
- aggregate statistics that are intentionally returned by the public
  `/api/stats` endpoint
- reports based only on automated scanner output without a reproducible impact

## Data and Privacy Notes

The calculator runs locally in the browser. The optional statistics backend
accepts validated events and stores aggregate data in Cloudflare D1. Private
diagnostic aggregates and administrative credentials must not be included in a
public report, screenshot, issue, or pull request.

When testing, use staging where possible. Do not access, alter, or retain data
that does not belong to you, and do not perform load testing against production
without prior authorization.

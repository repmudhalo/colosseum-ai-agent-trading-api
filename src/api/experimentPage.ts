export function renderExperimentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Experiment Dashboard</title>
</head>
<body>
  <h1>Live Experiment Dashboard</h1>
  <p>Use this page as a lightweight judge-facing entrypoint.</p>
  <p>Receipt verification endpoint example: <code>/receipts/verify/&lt;executionId&gt;</code></p>
</body>
</html>`;
}

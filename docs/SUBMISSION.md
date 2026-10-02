# Submission and Repository Requirements

## Repository

Create one dedicated public GitHub repository:

```text
flyrank-capstone-image-relevance
```

Do not put the project inside another repository.

## Required files

```text
README.md
capstone.yaml
EVIDENCE.md
BUILDLOG.md
.env.example
.gitignore
LICENSE
```

## README

Must include:

- what the system does,
- architecture diagram,
- setup instructions,
- exact run command,
- seed command,
- evaluation command,
- API endpoints,
- limitations,
- measured top-1 precision.

## capstone.yaml

Minimum shape:

```yaml
run: docker compose up --build
seed: npm run seed
test: npm test
base_url: http://localhost:3000
endpoints:
  - GET /health
  - POST /api/images
  - GET /api/posts/:id/images
  - GET /api/suggestions
```

Adjust commands to the actual implementation.

## EVIDENCE.md

Use one section per requirement.

Template:

```markdown
# Evidence

## Requirement: Vision output is schema validated

Test:
`npm run test:vision-schema`

Output:

```text
...
```

Conclusion:
PASS
```

Repeat for every requirement.

## BUILDLOG.md

Record:

- date,
- task,
- AI assistance,
- what the AI suggested,
- what was wrong,
- what was changed,
- what was verified.

Be honest.

## Security

Never commit:

- `.env`,
- API keys,
- access tokens,
- passwords,
- private credentials.

Add `.env` to `.gitignore`.

## Dataset

Do not commit a large binary dataset.

For this capstone, keep the small corpus reproducible through:

- a manifest,
- download script,
- source URLs,
- licensing information.

If the final corpus is small enough and licensing permits, it may be committed.

## Git history

Use meaningful commits.

Suggested milestones:

```text
chore: initialize capstone project
feat: add database schema
feat: add image ingestion
feat: add vision processing job
feat: add image embeddings
feat: add post embeddings
feat: add semantic matching
feat: add mismatch guard
feat: add review API
test: add evaluation dataset
docs: complete evidence and build log
```

Do not force-push away the development history.

# commuteliveserver

Install Bun
https://github.com/oven-sh/bun?tab=readme-ov-file

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

Database Schema:

If on server:

set -a
source /root/commute-live/app.env
set +a
bun run db:migrate

After local & server:
bun run db:migrate

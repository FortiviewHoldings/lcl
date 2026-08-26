# Contributing to .lcl

Thanks for your interest in .lcl. Contributions are welcome, and this page is
short: it explains the one thing every contribution needs before it can be
merged, and why.

## The short version

Every commit must carry a `Signed-off-by` line:

```bash
git commit -s -m "your message"
```

That line means you have read and agree to the **Contributor Terms** below,
for that contribution. Pull requests whose commits are not signed off cannot
be merged — not because of bureaucracy, but because merging code without a
clear licence grant permanently limits what the project can do with it.

If you forgot, you can add sign-off to your last commit:

```bash
git commit --amend -s --no-edit
```

Or to a whole branch:

```bash
git rebase --signoff main
```

## Why sign-off is required

.lcl is MIT licensed, and it stays that way. But the copyright holder also
builds proprietary software, and parts of .lcl may be used in products that
are **not** open source and are sold commercially.

Opening a pull request, on its own, grants no right to do that. And code
merged without that grant can never be relicensed afterwards — not by a later
agreement with the contributor, not by rewriting around it. The only clean
remedy is deleting the contribution and writing the feature again from
scratch, without reference to what was written. That is a bad outcome for
everyone, and it is entirely avoidable by settling the terms up front.

So the terms are stated before the first outside contribution, not after.

## Contributor Terms

By adding `Signed-off-by: Your Name <your@email>` to a commit, you certify
the following about that contribution.

### 1. You have the right to submit it

- The contribution is your original work, or you have the right to submit it
  under these terms.
- If your employer has rights to work you create, you have permission to make
  the contribution on your own behalf, or your employer has waived those
  rights or authorised the submission.
- The contribution does not knowingly include third-party code, assets or
  documentation that you are not permitted to contribute under these terms.
  If any part of it is third-party material, you have identified it in the
  pull request along with its licence.
- You are not knowingly submitting anything encumbered by a patent,
  confidentiality obligation, or agreement that conflicts with these terms.

### 2. Copyright licence

You keep the copyright in your contribution. **This is a licence, not a
transfer of ownership**, and it is non-exclusive — you remain free to use
your own contribution however you like, including in your own projects.

You grant **Bridges Industrial LLC**, and its affiliates, successors and
assigns, a perpetual, worldwide, non-exclusive, irrevocable, royalty-free,
transferable and sublicensable licence to reproduce, modify, adapt, publish,
create derivative works of, publicly display, distribute and otherwise
exploit your contribution, in whole or in part.

That licence expressly includes the right to **license and distribute your
contribution, and works derived from it, under any terms — including
proprietary, closed-source and commercial terms** — whether as part of .lcl
or as part of any other product or service.

### 3. Patent licence

You grant Bridges Industrial LLC, its affiliates, successors, assigns, and
all recipients of software distributed by them, a perpetual, worldwide,
non-exclusive, irrevocable (except as stated below), royalty-free patent
licence to make, have made, use, offer to sell, sell, import and otherwise
transfer your contribution and any work it is combined with, to the extent
your patent claims are necessarily infringed by that contribution alone or by
its combination with the project.

If you institute patent litigation alleging that .lcl or a contribution to it
constitutes patent infringement, the patent licences granted to you under
this section terminate as of the date that litigation is filed.

### 4. No warranty

Your contribution is provided as-is, without warranty of any kind. You are
not required to provide support for it, and unless you say otherwise you are
not expected to maintain it.

### 5. Public record

Your contribution, your name and the email address in your sign-off become
part of the project's public git history, and will be redistributed with it.
If you would rather not publish a personal address, GitHub's `noreply`
address works and is what this project's own commits use.

## Contributing on behalf of a company

If you are contributing as part of your job, make sure whoever owns your work
product has approved it. Sign off with your work email so the record matches
the entity granting the licence. If your employer needs a separate signed
agreement before that is true, say so in the pull request and it can be
arranged before review — that is much easier than unwinding a merge.

## Practical notes

- Keep pull requests focused; one concern per PR reviews faster.
- Run the gate before opening a PR: `node devtools/release.js --verify-only`.
- Every behaviour change needs a test or harness check alongside it. The
  project's standard is that a feature is not done until something proves it.
- Say what you measured, not what you expect to be true.

## A note on scope

These terms are about *licensing*, not about ownership of ideas or credit.
Contributors keep their copyright, keep their name in the history, and keep
the right to use their own work elsewhere. The grant exists so the project
can be built on commercially without having to strip contributions back out
later.

If anything here is unclear, or your situation does not fit, open an issue
before writing code and it can be sorted out first.

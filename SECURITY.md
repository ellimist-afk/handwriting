# Security

## supported version

Handwriting v0.13.9 is the supported version. Only the newest release is
supported.

## reporting a vulnerability

Do not open a normal issue for an exploitable defect. A public issue tells
everyone else how to use it before there is a fix.

Use GitHub private vulnerability reporting on this repository, under the
Security tab. That channel is private to the maintainer until a fix is out.

Include what you did, what happened, and what an attacker gets out of it. A
reproduction helps more than anything else.

## what belongs in the issue tracker instead

Ordinary crashes, hangs, rendering faults and data-loss bugs go in the normal
issue tracker, unless the defect crosses a security boundary. Losing your own
ink to a save bug is a serious bug, and it is not a vulnerability. Reading or
writing a file outside the vault, or executing something a note controls,
would be.

If you are not sure which one you have, use private reporting. It is easy to
move a report into the open later, and impossible to take one back.

## scope

Handwriting makes no network requests, has no accounts, and runs no server.
The realistic surface is what it reads and writes on disk, and what it does
with content that comes from a note or a sidecar file.

## no bug bounty

There is no bug-bounty program and no payment for reports.

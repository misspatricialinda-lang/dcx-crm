# Workflow snapshots

The three workflow JSON files in the project root are the working copies. A folder such as `v0.1.0` is an immutable snapshot of all three files at one point in time. Each snapshot includes a manifest with creation time, a note, and SHA-256 hashes.

Before changing a workflow, snapshot the current working copies. After the change is complete, create a new snapshot:

```powershell
./scripts/snapshot-workflows.ps1 -Version v0.2.0 -Note 'Describe the change'
```

Use a new version number each time. The script refuses to overwrite an existing snapshot. Keep the exported JSON from n8n separate from these local versions until its identity and published status have been verified. A local snapshot does **not** mean that n8n has imported or published it.

Suggested version increments: patch (`v0.1.1`) for a small fix, minor (`v0.2.0`) for changed workflow behavior, and major (`v1.0.0`) once the complete production path has passed live tests.

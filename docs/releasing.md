# Publishing Gus

Publish only the exact archive that passed the release checks. Review both the
packed files and the registry metadata: npm can record a tarball's local path
in the published `_from` and `_resolved` fields.

1. Update the package version, lockfile root version, and README examples on a
   feature branch. Complete the relevant checks and build the package.
2. Copy the verified archive to a disposable directory with a generic path,
   such as `/tmp/gus-release`, and confirm its checksum is unchanged. Keep
   account names, other repository names, and private directory names out of
   this path.
3. From that directory, publish the archive using its relative filename and
   complete npm's authentication flow. Do not publish a second, unverified
   build from a working checkout.
4. Read the anonymous registry metadata, including every published version's
   `_from` and `_resolved`, rather than inspecting only the npm web page.
   Confirm the version and tag, then download the public tarball and compare
   its checksum with the verified archive.
5. Merge the reviewed source through the repository's normal PR process and
   verify that the published source and archive represent the same release.

An archive audit alone does not cover fields added by the publishing client.

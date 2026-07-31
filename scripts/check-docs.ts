const files = [...new Bun.Glob("docs/**/*.md").scanSync()];

if (files.length === 0) {
  throw new Error("No documentation files found");
}

console.log(`Checked ${files.length} documentation files`);

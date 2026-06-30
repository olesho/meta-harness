// Strip IDE-injected and system-injected context tags from prompt text so they
// don't leak into rendered transcripts. Ported from harness-wrapper's
// strip_tags.go (originally entireio/cli textutil/ide_tags.go).

const ideContextTagRegex = /<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g

const systemTagRegexes: RegExp[] = [
  /<local-command-caveat[^>]*>[\s\S]*?<\/local-command-caveat>/g,
  /<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g,
  /<command-name[^>]*>[\s\S]*?<\/command-name>/g,
  /<command-message[^>]*>[\s\S]*?<\/command-message>/g,
  /<command-args[^>]*>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout[^>]*>[\s\S]*?<\/local-command-stdout>/g,
  /<\/?user_query>/g,
]

export function stripIDEContextTags(text: string): string {
  let result = text.replace(ideContextTagRegex, "")
  for (const re of systemTagRegexes) {
    result = result.replace(re, "")
  }
  return result.trim()
}

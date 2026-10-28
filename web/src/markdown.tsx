/**
 * Lightweight, dependency-free Markdown renderer for chat text.
 * Produces React nodes directly (no innerHTML), covering the constructs model
 * replies actually use: headings, fenced code, lists, quotes, rules, links and
 * the inline set (**bold** / *italic* / `code` / ~~strike~~ / [text](url)).
 */
import type { ReactNode } from 'react'

/** Top-level block rendering. */
export function Markdown({ text }: { text: string }): ReactNode {
  return <>{parseBlocks(text.split('\n'))}</>
}

function parseBlocks(lines: string[]): ReactNode[] {
  const blocks: ReactNode[] = []
  let key = 0
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!

    // Blank separator
    if (line.trim().length === 0) { index += 1; continue }

    // Fenced code block
    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      index += 1 // closing fence
      blocks.push(<pre className="md-code" key={key++}><code>{body.join('\n')}</code></pre>)
      continue
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1]!.length, 4)
      blocks.push(<p className={`md-h${level}`} key={key++}>{parseInline(heading[2]!)}</p>)
      index += 1
      continue
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr className="md-hr" key={key++} />)
      index += 1
      continue
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) {
        body.push(lines[index]!.replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push(<blockquote className="md-quote" key={key++}>{parseBlocks(body)}</blockquote>)
      continue
    }

    // Lists (unordered / ordered), with simple indentation nesting
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      const items: Array<{ depth: number; ordered: boolean; text: string }> = []
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]!)
        if (!match) break
        items.push({
          depth: Math.floor(match[1]!.length / 2),
          ordered: /^\d/.test(match[2]!),
          text: match[3]!,
        })
        index += 1
      }
      blocks.push(<ul className="md-list" key={key++}>{renderListItems(items, 0)}</ul>)
      continue
    }

    // Table
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[index + 1]!)) {
      const rows: string[][] = []
      while (index < lines.length && lines[index]!.includes('|')) {
        if (!/^\s*\|?[\s:-]+\|/.test(lines[index]!)) {
          rows.push(splitTableRow(lines[index]!))
        }
        index += 1
      }
      blocks.push(
        <div className="md-table-wrap" key={key++}>
          <table className="md-table">
            <thead><tr>{rows[0]?.map((cell, i) => <th key={i}>{parseInline(cell)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i}>{parseInline(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      )
      continue
    }

    // Paragraph (merge consecutive plain lines)
    const paragraph: string[] = []
    while (index < lines.length && lines[index]!.trim().length > 0
      && !/^\s*```/.test(lines[index]!) && !/^(#{1,6})\s/.test(lines[index]!)
      && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[index]!) && !/^\s*>\s?/.test(lines[index]!)
      && !/^\s*([-*_])\1{2,}\s*$/.test(lines[index]!)) {
      paragraph.push(lines[index]!)
      index += 1
    }
    blocks.push(<p className="md-p" key={key++}>{paragraph.map((part, i) => <span key={i}>{i > 0 && <br />}{parseInline(part)}</span>)}</p>)
  }
  return blocks
}

function renderListItems(items: Array<{ depth: number; ordered: boolean; text: string }>, depth: number): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  let index = 0
  while (index < items.length) {
    const item = items[index]!
    if (item.depth < depth) break
    if (item.depth > depth) {
      const nested: Array<{ depth: number; ordered: boolean; text: string }> = []
      while (index < items.length && items[index]!.depth > depth) {
        nested.push({ ...items[index]!, depth: items[index]!.depth - 1 })
        index += 1
      }
      const last = nodes.pop()
      nodes.push(<span key={key++}>{last}{item.ordered ? <ol className="md-list">{renderListItems(nested, 0)}</ol> : <ul className="md-list">{renderListItems(nested, 0)}</ul>}</span>)
      continue
    }
    nodes.push(<li key={key++}>{parseInline(item.text)}</li>)
    index += 1
  }
  return nodes
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
}

/** Inline parsing via a single tokenizer pass. */
export function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))|(https?:\/\/[^\s<]+)/g
  let key = 0
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('`')) nodes.push(<code className="md-inline-code" key={key++}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('~~')) nodes.push(<del key={key++}>{token.slice(2, -2)}</del>)
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      nodes.push(<a className="md-link" key={key++} href={link?.[2] ?? '#'} target="_blank" rel="noreferrer">{link?.[1] ?? token}</a>)
    } else if (token.startsWith('http')) nodes.push(<a className="md-link" key={key++} href={token} target="_blank" rel="noreferrer">{token}</a>)
    else nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

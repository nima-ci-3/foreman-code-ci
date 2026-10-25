import { memo } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { CodeBlock } from '../../shared/ui/nocturne'
import './conversationHistory.css'
import './chatMessageBody.css'

const markdownComponents: Components = {
  pre({ node }) {
    const code = node?.children[0]
    if (code?.type !== 'element') return null
    const text = code.children.map(child => child.type === 'text' ? child.value : '').join('')
    const classes = code.properties.className
    const language = Array.isArray(classes)
      ? classes.map(String).find(value => value.startsWith('language-'))?.slice(9) : undefined
    return <CodeBlock code={text.replace(/\n$/, '')} label="Code" language={language ?? 'text'} />
  },
  a({ children, href }) {
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  img({ alt }) {
    return <span>{alt}</span>
  },
}

/** Markdown the way every chat renders an assistant's words: no raw HTML, safe links, shared code blocks. */
export const ChatMarkdown = memo(function ChatMarkdown({ content }: { content: string }) {
  return <Markdown components={markdownComponents} skipHtml>{content}</Markdown>
})

/** One message body for every chat surface: only the assistant's words render as Markdown, everyone else's stay plain text. */
export function ChatMessageBody({ content, role = 'assistant' }: { content: string; role?: string }) {
  return role !== 'assistant' ? <div className="conversation-message-content">{content}</div>
    : <div className="conversation-message-content chat-message-body"><ChatMarkdown content={content} /></div>
}

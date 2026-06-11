import { useEffect, useState } from 'react'
import { File } from 'lucide-react'
import { electronClient } from '@/shared/api/electron-client'
import { cn } from '@/lib/utils'

export function AttachmentPreviewImage({
  attachment,
  className,
  fallbackClassName,
}: {
  attachment: ChatAttachment
  className: string
  fallbackClassName: string
}) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)

    if (attachment.kind !== 'image') return
    void electronClient?.readAttachmentPreview(attachment.path)
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })

    return () => {
      cancelled = true
    }
  }, [attachment.kind, attachment.path])

  if (src) {
    return <img src={src} alt="" className={className} />
  }

  return (
    <div className={cn('flex items-center justify-center text-muted-foreground', fallbackClassName)}>
      <File className="size-4" />
    </div>
  )
}

export function PublicPageIntro({ title, description, category: _category }: {
  title: string; description: string; category?: string; guide?: string; guideLabel?: string
}) {
  return <div className="flex flex-col gap-5 pb-10 sm:pb-12">
    <div>
      <div className="flex max-w-3xl flex-col gap-4"><h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">{title}</h1><p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">{description}</p></div>
    </div>
  </div>
}

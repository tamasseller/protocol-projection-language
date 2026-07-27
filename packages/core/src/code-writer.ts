export class CodeWriter
{
    private latent: ((ind: string) => string[])[] = []

    writeLine(content: string): void
    {
        this.latent.push((ind) => [ind + content]);
    }

    writeBlock(writer: CodeWriter): void
    {
        this.latent.push((ind) => [
            ind + "{",
            ...writer.render(ind).map(x => ind + x),
            ind + "}"
        ]);
    }

    render(ind: string = "    "): string[]
    {
        return this.latent.map(x => x(ind)).flat(1)
    }
}


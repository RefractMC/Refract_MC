interface Props { size?: number }

function BlockIcon({ pattern, size = 18 }: { pattern: string[]; size?: number }) {
  const rows = pattern.length
  const cols = pattern[0].length
  return (
    <div style={{ width:size,height:size,display:'grid',gridTemplateColumns:`repeat(${cols},1fr)`,gridTemplateRows:`repeat(${rows},1fr)` }}>
      {pattern.flatMap((row,r)=>[...row].map((ch,c)=> ch==='.' ? null :
        <div key={`${r}-${c}`} style={{ background:'currentColor',gridColumn:c+1,gridRow:r+1 }} />
      ))}
    </div>
  )
}

export const LibraryIcon  = (p:Props) => <BlockIcon size={p.size} pattern={['X.XX.','X.XX.','X.XX.','X.XX.','X.XX.']} />
export const ModsIcon     = (p:Props) => <BlockIcon size={p.size} pattern={['..X..', '.XXX.','XXXXX', '.XXX.','..X..']} />
export const ModpacksIcon = (p:Props) => <BlockIcon size={p.size} pattern={['.XXX.','X...X','X...X','X...X','.XXX.']} />
export const AccountIcon  = (p:Props) => <BlockIcon size={p.size} pattern={['.XX..', '.XX..','XXXX.','XXXX.','X..X.']} />
export const CogIcon      = (p:Props) => <BlockIcon size={p.size} pattern={['X.X.X', '.XXX.','XX.XX', '.XXX.','X.X.X']} />
export const BellIcon     = (p:Props) => <BlockIcon size={p.size} pattern={['..X..', '.XXX.','XXXXX','XXXXX','..X..']} />
export const SearchIcon   = (p:Props) => <BlockIcon size={p.size} pattern={['.XX..','X..X.','X..X.','.XX..','...XX']} />
export const ChevLeftIcon = (p:Props) => <BlockIcon size={p.size} pattern={['..X..','.X...','X....', '.X...','..X..']} />
export const ChevRightIcon = (p:Props) => <BlockIcon size={p.size} pattern={['..X..','...X.','....X','...X.','..X..']} />

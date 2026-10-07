import { Button, Select, Space, message } from 'antd'
import { toDataURL } from 'qrcode'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Student = { id: number; admissionNo: string; name: string; active: boolean; enrollment: { sectionId: number; className: string } }
type Standard = { id: number; name: string; sections: { id: number; name: string }[] }

// Client-side only: the QR payload is just the admission number.
const PRINT_CSS = `
.qr-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.qr-card{border:1px dashed #999;padding:6px;text-align:center;break-inside:avoid;font-size:11px;line-height:1.25}
.qr-card img{width:100%;max-width:120px}
@media print{body *{visibility:hidden}#qr-sheet,#qr-sheet *{visibility:visible}#qr-sheet{position:absolute;left:0;top:0;width:100%}@page{size:A4;margin:10mm}}`

export default function QrSheet() {
  const { schoolId, yearId } = useSelection()
  const [standards, setStandards] = useState<Standard[]>([])
  const [standardId, setStandardId] = useState<number>()
  const [sectionId, setSectionId] = useState<number>()
  const [cards, setCards] = useState<{ s: Student; img: string }[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (schoolId) api<Standard[]>(`/standards?schoolId=${schoolId}`).then(setStandards).catch((e) => message.error(e.message))
  }, [schoolId])

  async function generate() {
    if (!schoolId || !yearId || !standardId) return
    setBusy(true)
    try {
      const list = (await api<Student[]>(`/students?schoolId=${schoolId}&yearId=${yearId}&standardId=${standardId}`))
        .filter((s) => s.active && (!sectionId || s.enrollment.sectionId === sectionId))
      setCards(await Promise.all(list.map(async (s) => ({ s, img: await toDataURL(s.admissionNo, { margin: 1, width: 240 }) }))))
      if (!list.length) message.info('No active students in that class')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sections = (standards.find((s) => s.id === standardId)?.sections ?? []).map((s) => ({ value: s.id, label: s.name }))

  return (
    <>
      <style>{PRINT_CSS}</style>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="Class" style={{ width: 160 }} value={standardId} onChange={(v) => (setStandardId(v), setSectionId(undefined), setCards([]))}
          options={standards.map((s) => ({ value: s.id, label: s.name }))} />
        <Select allowClear placeholder="All sections" style={{ width: 130 }} value={sectionId} onChange={setSectionId} options={sections} disabled={!standardId} />
        <Button type="primary" disabled={!standardId} loading={busy} onClick={generate}>Generate</Button>
        <Button disabled={!cards.length} onClick={() => window.print()}>Print ({cards.length})</Button>
      </Space>
      <div id="qr-sheet" className="qr-grid">
        {cards.map(({ s, img }) => (
          <div key={s.id} className="qr-card">
            <img src={img} alt={`QR ${s.admissionNo}`} />
            <div><b>{s.name}</b></div>
            <div>{s.admissionNo} · {s.enrollment.className}</div>
          </div>
        ))}
      </div>
    </>
  )
}

import { Alert, Button, Checkbox, Divider, Empty, Popconfirm, Select, Space, Table, Typography, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Gate } from '../session'
import { useSelection } from '../selection'

type Standard = { id: number; name: string; sections: { id: number; name: string }[] }
type Candidate = { id: number; admissionNo: string; name: string }

// Bulk year-end promotion: move every active student of one section into
// another section for the next year, holding back whoever gets unchecked.
export default function Promotion() {
  return (
    <>
      <PromoteSection />
      <Divider />
      <UndoSection />
    </>
  )
}

function PromoteSection() {
  const { schoolId, years } = useSelection()
  const [standards, setStandards] = useState<Standard[]>([])
  const [fromYearId, setFromYearId] = useState<number>()
  const [toYearId, setToYearId] = useState<number>()
  const [fromSectionId, setFromSectionId] = useState<number>()
  const [toSectionId, setToSectionId] = useState<number>()
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [excluded, setExcluded] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (schoolId) api<Standard[]>(`/standards?schoolId=${schoolId}`).then(setStandards).catch((e) => message.error(e.message))
  }, [schoolId])

  useEffect(() => {
    setCandidates([])
    setExcluded(new Set())
    if (schoolId && fromYearId && fromSectionId) {
      api<Candidate[]>(`/promotions/candidates?schoolId=${schoolId}&fromYearId=${fromYearId}&fromSectionId=${fromSectionId}`)
        .then(setCandidates)
        .catch((e) => message.error(e.message))
    }
  }, [schoolId, fromYearId, fromSectionId])

  const sectionOptions = standards.flatMap((s) => s.sections.map((sec) => ({ value: sec.id, label: `${s.name} ${sec.name}` })))

  function toggle(id: number, checked: boolean) {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (checked) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function promote() {
    try {
      const { promoted, alreadyEnrolled } = await api<{ promoted: number; alreadyEnrolled: string[] }>('/promotions', {
        method: 'POST',
        body: JSON.stringify({
          fromYearId, toYearId, fromSectionId, toSectionId,
          excludeStudentIds: [...excluded],
        }),
      })
      message.success(`Promoted ${promoted} student(s)${alreadyEnrolled.length ? `; already in target year: ${alreadyEnrolled.join(', ')}` : ''}`)
      setCandidates([])
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const ready = fromYearId && toYearId && fromSectionId && toSectionId && fromYearId !== toYearId

  return (
    <>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="From year" style={{ width: 140 }} value={fromYearId} onChange={setFromYearId}
          options={years.map((y) => ({ value: y.id, label: y.label }))} />
        <Select placeholder="From class & section" style={{ width: 200 }} value={fromSectionId} onChange={setFromSectionId}
          options={sectionOptions} showSearch optionFilterProp="label" />
        <span>&rarr;</span>
        <Select placeholder="To year" style={{ width: 140 }} value={toYearId} onChange={setToYearId}
          options={years.map((y) => ({ value: y.id, label: y.label }))} />
        <Select placeholder="To class & section" style={{ width: 200 }} value={toSectionId} onChange={setToSectionId}
          options={sectionOptions} showSearch optionFilterProp="label" />
      </Space>

      {!candidates.length ? (
        <Empty description="Pick a from-year and section to load students" />
      ) : (
        <>
          <Table rowKey="id" dataSource={candidates} pagination={false} style={{ marginBottom: 16 }}
            columns={[
              {
                title: 'Promote', width: 90,
                render: (_: unknown, c: Candidate) => (
                  <Checkbox checked={!excluded.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                ),
              },
              { title: 'Adm. no.', dataIndex: 'admissionNo' },
              { title: 'Name', dataIndex: 'name' },
            ]} />
          <Button type="primary" disabled={!ready} onClick={promote}>
            Promote {candidates.length - excluded.size} student(s)
          </Button>
        </>
      )}
    </>
  )
}

type Enrolled = { id: number; admissionNo: string; name: string; enrollment: { sectionId: number } }

// Downgrade: undo a mistaken promotion. Students with payments that year, withdrawals or new admissions are skipped by the server.
function UndoSection() {
  const { schoolId, years } = useSelection()
  const [standards, setStandards] = useState<Standard[]>([])
  const [yearId, setYearId] = useState<number>()
  const [sectionId, setSectionId] = useState<number>()
  const [rows, setRows] = useState<Enrolled[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [skipped, setSkipped] = useState<{ studentId: number; reason: string }[]>([])

  useEffect(() => {
    if (schoolId) api<Standard[]>(`/standards?schoolId=${schoolId}`).then(setStandards).catch((e) => message.error(e.message))
  }, [schoolId])

  const load = () => {
    setPicked([])
    if (!schoolId || !yearId || !sectionId) return setRows([])
    api<Enrolled[]>(`/students?schoolId=${schoolId}&yearId=${yearId}`)
      .then((all) => setRows(all.filter((s) => s.enrollment.sectionId === sectionId)))
      .catch((e) => message.error(e.message))
  }
  useEffect(load, [schoolId, yearId, sectionId])

  async function undo() {
    try {
      const r = await api<{ undone: number; skipped: { studentId: number; reason: string }[] }>('/promotions/undo', {
        method: 'POST', body: JSON.stringify({ yearId, sectionId, studentIds: picked }),
      })
      message.success(`Removed ${r.undone} student(s) from this section`)
      setSkipped(r.skipped)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const sectionOptions = standards.flatMap((s) => s.sections.map((sec) => ({ value: sec.id, label: `${s.name} ${sec.name}` })))
  const name = (id: number) => rows.find((r) => r.id === id)?.name ?? `#${id}`

  return (
    <>
      <Typography.Title level={5}>Undo a promotion</Typography.Title>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="Year" style={{ width: 140 }} value={yearId} onChange={setYearId} options={years.map((y) => ({ value: y.id, label: y.label }))} />
        <Select placeholder="Class & section" style={{ width: 200 }} value={sectionId} onChange={setSectionId} options={sectionOptions} showSearch optionFilterProp="label" />
        <Gate cap="promotions.undo"><Popconfirm title={`Remove ${picked.length} student(s) from this section and year?`} onConfirm={undo} disabled={!picked.length}>
          <Button danger disabled={!picked.length}>Undo promotion for {picked.length}</Button>
        </Popconfirm></Gate>
      </Space>
      {!rows.length ? <Empty description="Pick the year and section the students were promoted into" /> : (
        <Table rowKey="id" size="small" dataSource={rows} pagination={false} rowSelection={{ selectedRowKeys: picked, onChange: (k) => setPicked(k as number[]) }}
          columns={[{ title: 'Adm. no.', dataIndex: 'admissionNo' }, { title: 'Name', dataIndex: 'name' }]} />
      )}
      {skipped.length > 0 && (
        <Alert style={{ marginTop: 16 }} type="warning" showIcon message="Not removed" description={skipped.map((s) => `${name(s.studentId)}: ${s.reason}`).join(' · ')} />
      )}
    </>
  )
}

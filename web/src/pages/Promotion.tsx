import { Button, Checkbox, Empty, Select, Space, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useSelection } from '../selection'

type Standard = { id: number; name: string; sections: { id: number; name: string }[] }
type Candidate = { id: number; admissionNo: string; name: string }

// Bulk year-end promotion: move every active student of one section into
// another section for the next year, holding back whoever gets unchecked.
export default function Promotion() {
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

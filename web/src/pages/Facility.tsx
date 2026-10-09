import { Button, Empty, Input, InputNumber, Popconfirm, Space, Table, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Gate, useCan } from '../session'
import { useSelection } from '../selection'
import type { Installment } from './Installments'

type Facility = { id: number; name: string }
type Cell = { facilityId: number; installmentId: number; amount: string }
const key = (f: number, i: number) => `${f}:${i}`
const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Shared screen for transport routes, transport slabs (fare tiers) and hostel rooms: a named list of plans,
// each priced per installment. `kind` picks which one; Transport.tsx/Hostel.tsx wrap this.
export default function FacilityPage({ kind, label }: { kind: 'TRANSPORT' | 'HOSTEL' | 'SLAB'; label: string }) {
  const { schoolId, yearId } = useSelection()
  const can = useCan()
  const [rows, setRows] = useState<Facility[]>([])
  const [insts, setInsts] = useState<Installment[]>([])
  const [amounts, setAmounts] = useState<Record<string, number>>({})
  const [dirty, setDirty] = useState(false)
  const [newName, setNewName] = useState('')

  const loadRows = () => schoolId && api<Facility[]>(`/facilities?schoolId=${schoolId}&kind=${kind}`).then(setRows).catch((e) => message.error(e.message))
  useEffect(() => { loadRows() }, [schoolId, kind])

  useEffect(() => {
    if (schoolId && yearId) api<Installment[]>(`/installments?schoolId=${schoolId}&yearId=${yearId}`).then(setInsts).catch((e) => message.error(e.message))
  }, [schoolId, yearId])

  const fill = (cells: Cell[]) => {
    setAmounts(Object.fromEntries(cells.map((c) => [key(c.facilityId, c.installmentId), Number(c.amount)])))
    setDirty(false)
  }
  useEffect(() => {
    if (schoolId && yearId) api<Cell[]>(`/facilities/structure?yearId=${yearId}&schoolId=${schoolId}&kind=${kind}`).then(fill).catch((e) => message.error(e.message))
  }, [schoolId, yearId, kind])

  async function addFacility() {
    if (!newName.trim()) return
    try {
      await api('/facilities', { method: 'POST', body: JSON.stringify({ schoolId, kind, name: newName.trim() }) })
      setNewName('')
      loadRows()
    } catch (e) {
      message.error((e as Error).message)
    }
  }
  async function removeFacility(id: number) {
    try {
      await api(`/facilities/${id}`, { method: 'DELETE' })
      loadRows()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  async function save() {
    const items = Object.entries(amounts)
      .filter(([, amount]) => amount > 0)
      .map(([k, amount]) => {
        const [facilityId, installmentId] = k.split(':').map(Number)
        return { facilityId, installmentId, amount }
      })
    try {
      fill(await api<Cell[]>('/facilities/structure', { method: 'PUT', body: JSON.stringify({ yearId, schoolId, kind, items }) }))
      message.success(`${label} fees saved`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const amt = (f: number, i: number) => amounts[key(f, i)] ?? 0
  const rowTotal = (f: number) => insts.reduce((s, i) => s + amt(f, i.id), 0)

  return (
    <>
      {can('facilities.write') && <Space style={{ marginBottom: 16 }}>
        <Input placeholder={`New ${label.toLowerCase()} name`} value={newName} onChange={(e) => setNewName(e.target.value)} onPressEnter={addFacility} style={{ width: 200 }} />
        <Button onClick={addFacility}>Add {label.toLowerCase()}</Button>
      </Space>}
      {!rows.length || !insts.length ? (
        <Empty description={`Add a ${label.toLowerCase()} and installments for this school and year first`} />
      ) : (
        <>
          <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} bordered style={{ marginBottom: 16 }}
            columns={[
              { title: label, dataIndex: 'name', fixed: 'left' },
              ...insts.map((i) => ({
                title: i.label,
                key: i.id,
                render: (_: unknown, f: Facility) => (
                  <InputNumber min={0} precision={2} style={{ width: 120 }} value={amt(f.id, i.id) || null} disabled={!can('facilityStructure.write')}
                    onChange={(v) => {
                      setAmounts((a) => ({ ...a, [key(f.id, i.id)]: v ?? 0 }))
                      setDirty(true)
                    }} />
                ),
              })),
              { title: 'Total', key: 'total', align: 'right' as const, render: (_: unknown, f: Facility) => money(rowTotal(f.id)) },
              {
                title: '', key: 'del', render: (_: unknown, f: Facility) => (
                  <Gate cap="facilities.write" hide><Popconfirm title={`Delete this ${label.toLowerCase()}?`} onConfirm={() => removeFacility(f.id)}>
                    <Button size="small" danger>Delete</Button>
                  </Popconfirm></Gate>
                ),
              },
            ]} />
          <Gate cap="facilityStructure.write"><Button type="primary" onClick={save} disabled={!dirty}>Save {label.toLowerCase()} fees</Button></Gate>
        </>
      )}
    </>
  )
}

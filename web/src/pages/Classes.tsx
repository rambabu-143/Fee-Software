import { Button, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Gate, useCan } from '../session'
import { useSelection } from '../selection'

type Section = { id: number; name: string; classTeacher?: string | null }
type Standard = { id: number; name: string; sortOrder: number; sections: Section[] }

export default function Classes() {
  const { schoolId } = useSelection()
  const edit = useCan()('standards.write')
  const [rows, setRows] = useState<Standard[]>([])
  const [editing, setEditing] = useState<Partial<Standard> | null>(null)
  const [teacher, setTeacher] = useState<Section | null>(null)
  const [teacherName, setTeacherName] = useState('')
  const [form] = Form.useForm()

  const run = (p: Promise<unknown>) => p.then(load).catch((e) => message.error(e.message))
  const load = async () => {
    if (schoolId) setRows(await api<Standard[]>(`/standards?schoolId=${schoolId}`))
  }
  useEffect(() => void run(Promise.resolve()), [schoolId])

  function save(values: { name: string; sortOrder: number }) {
    const req = editing?.id
      ? api(`/standards/${editing.id}`, { method: 'PATCH', body: JSON.stringify(values) })
      : api('/standards', { method: 'POST', body: JSON.stringify({ ...values, schoolId }) })
    run(req.then(() => setEditing(null)))
  }

  function saveTeacher() {
    run(api(`/sections/${teacher!.id}`, { method: 'PATCH', body: JSON.stringify({ classTeacher: teacherName.trim() }) }).then(() => setTeacher(null)))
  }

  function addSection(standardId: number, input: HTMLInputElement) {
    const name = input.value.trim()
    if (!name) return
    input.value = ''
    run(api('/sections', { method: 'POST', body: JSON.stringify({ standardId, name }) }))
  }

  return (
    <>
      <Gate cap="standards.write"><Button type="primary" style={{ marginBottom: 16 }} onClick={() => {
        form.setFieldsValue({ name: '', sortOrder: rows.length })
        setEditing({})
      }}>
        Add class
      </Button></Gate>
      <Table rowKey="id" dataSource={rows} pagination={false} scroll={{ x: true }} columns={[
        { title: 'Order', dataIndex: 'sortOrder', width: 80 },
        { title: 'Class', dataIndex: 'name' },
        {
          title: 'Sections',
          render: (_, r) => (
            <Space wrap>
              {r.sections.map((s) => (
                <Tag key={s.id} closable={edit} style={{ cursor: edit ? 'pointer' : 'default' }} title={edit ? 'Click to set class teacher' : undefined}
                  onClick={() => {
                    if (!edit) return
                    setTeacherName(s.classTeacher ?? '')
                    setTeacher(s)
                  }}
                  onClose={(e) => {
                    e.preventDefault()
                    run(api(`/sections/${s.id}`, { method: 'DELETE' }))
                  }}>
                  {s.name}{s.classTeacher ? ` · ${s.classTeacher}` : ''}
                </Tag>
              ))}
              {edit && <Input size="small" placeholder="+ Section, Enter" style={{ width: 130 }}
                onPressEnter={(e) => addSection(r.id, e.currentTarget)} />}
            </Space>
          ),
        },
        {
          title: '',
          render: (_, r) => (
            <Space>
              <Gate cap="standards.write" hide><Button size="small" onClick={() => {
                form.setFieldsValue(r)
                setEditing(r)
              }}>Edit</Button></Gate>
              <Gate cap="standards.write" hide><Popconfirm title="Delete this class?" onConfirm={() => run(api(`/standards/${r.id}`, { method: 'DELETE' }))}>
                <Button size="small" danger>Delete</Button>
              </Popconfirm></Gate>
            </Space>
          ),
        },
      ]} />
      <Modal title={editing?.id ? 'Edit class' : 'Add class'} open={!!editing} onCancel={() => setEditing(null)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="name" label="Class name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="sortOrder" label="Display order" rules={[{ required: true }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={`Class teacher, section ${teacher?.name ?? ''}`} open={!!teacher} onCancel={() => setTeacher(null)} onOk={saveTeacher}>
        <Input value={teacherName} onChange={(e) => setTeacherName(e.target.value)} placeholder="Class teacher name (printed on concession forms)" />
      </Modal>
    </>
  )
}

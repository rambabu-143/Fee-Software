import { Button, Form, Input, InputNumber, Modal, Select, Space, message } from 'antd'
import { useEffect, useState } from 'react'
import { api } from './api'

type Row = { feeHeadId: number; percent: string | null; amount: string | null; reason: string }
type FormRow = { feeHeadId: number; kind: 'percent' | 'amount'; value: number; reason: string }

// Per-student discounts for the selected year; the server replaces the whole list on save.
export function ConcessionsModal({ student, yearId, heads, onClose }: {
  student: { id: number; name: string } | null; yearId?: number; heads: { id: number; name: string }[]; onClose: () => void
}) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!student) return
    form.resetFields()
    api<Row[]>(`/students/${student.id}/concessions?yearId=${yearId}`)
      .then((rows) => form.setFieldValue('items', rows.map((r) => ({
        feeHeadId: r.feeHeadId, reason: r.reason,
        kind: r.percent !== null ? 'percent' : 'amount', value: Number(r.percent ?? r.amount),
      }))))
      .catch((e) => message.error(e.message))
  }, [student, yearId])

  async function save({ items = [] }: { items?: FormRow[] }) {
    setSaving(true)
    try {
      await api(`/students/${student!.id}/concessions`, {
        method: 'PUT',
        body: JSON.stringify({ yearId, items: items.map(({ kind, value, ...i }) => ({ ...i, [kind]: value })) }),
      })
      message.success('Concessions saved')
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={student && `Concessions · ${student.name}`} open={!!student} onCancel={onClose} onOk={form.submit}
      okText="Save" confirmLoading={saving} width={780}>
      <Form form={form} onFinish={save}>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f) => (
                <Space key={f.key} wrap align="start">
                  <Form.Item name={[f.name, 'feeHeadId']} rules={[{ required: true, message: 'Head' }]}>
                    <Select showSearch optionFilterProp="label" placeholder="Fee head" style={{ width: 160 }} options={heads.map((h) => ({ value: h.id, label: h.name }))} />
                  </Form.Item>
                  <Form.Item name={[f.name, 'kind']} initialValue="percent">
                    <Select style={{ width: 140 }} options={[{ value: 'percent', label: '% off' }, { value: 'amount', label: '₹ off / installment' }]} />
                  </Form.Item>
                  <Form.Item name={[f.name, 'value']} rules={[{ required: true, message: 'Value' }]}>
                    <InputNumber min={0.01} precision={2} style={{ width: 110 }} />
                  </Form.Item>
                  <Form.Item name={[f.name, 'reason']} rules={[{ required: true, min: 2, message: 'Reason' }]}>
                    <Input placeholder="Reason (e.g. Sibling)" style={{ width: 150 }} />
                  </Form.Item>
                  <Button danger onClick={() => remove(f.name)}>Remove</Button>
                </Space>
              ))}
              <Button type="dashed" onClick={() => add()} block>Add concession</Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  )
}

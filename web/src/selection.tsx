import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { message } from 'antd'
import { api } from './api'

export type School = { id: number; code: string; name: string }
export type Year = { id: number; label: string; startDate: string; endDate: string; isCurrent: boolean }

type Selection = {
  schools: School[]
  years: Year[]
  schoolId?: number
  yearId?: number
  setSchoolId: (id: number) => void
  setYearId: (id: number) => void
  reload: () => void
}

const Ctx = createContext<Selection>(null!)
export const useSelection = () => useContext(Ctx)

const stored = (key: string) => {
  try {
    return Number(localStorage.getItem(key)) || undefined
  } catch {
    return undefined
  }
}
const store = (key: string, v: number) => {
  try {
    localStorage.setItem(key, String(v))
  } catch {
    /* private mode: selection just isn't remembered */
  }
}

// The school + academic year every master page works within.
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [schools, setSchools] = useState<School[]>([])
  const [years, setYears] = useState<Year[]>([])
  const [schoolId, setSchool] = useState(stored('schoolId'))
  const [yearId, setYear] = useState(stored('yearId'))

  const reload = () => {
    Promise.all([api<School[]>('/schools'), api<Year[]>('/years')])
      .then(([s, y]) => {
        setSchools(s)
        setYears(y)
        setSchool((cur) => (s.some((x) => x.id === cur) ? cur : s[0]?.id))
        setYear((cur) => (y.some((x) => x.id === cur) ? cur : (y.find((x) => x.isCurrent) ?? y[0])?.id))
      })
      .catch((e) => message.error(e.message))
  }
  useEffect(reload, [])

  const setSchoolId = (id: number) => (store('schoolId', id), setSchool(id))
  const setYearId = (id: number) => (store('yearId', id), setYear(id))

  return <Ctx.Provider value={{ schools, years, schoolId, yearId, setSchoolId, setYearId, reload }}>{children}</Ctx.Provider>
}

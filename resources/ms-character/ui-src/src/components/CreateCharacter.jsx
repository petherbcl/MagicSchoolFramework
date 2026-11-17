import { useState } from "react";
import { HOUSES } from "../houses.js";

const field = "mt-2 block w-full border border-stone-500 bg-night p-3 font-sans text-[15px] text-white focus:outline-2 focus:outline-offset-2 focus:outline-gold";

// Client-side limits mirror the server (2–32 letters); the server is still the authority.
export default function CreateCharacter({ busy, onSubmit, onCancel }) {
  const [form, setForm] = useState({ firstName: "", lastName: "", house: "Unaffiliated" });
  const update = key => event => setForm({ ...form, [key]: event.target.value });
  return (
    <form className="mt-4" onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(form); }}>
      <div className="flex gap-4">
        <label className="my-3 block flex-1 text-[15px]">Nome
          <input className={field} value={form.firstName} onChange={update("firstName")} minLength={2} maxLength={32} required autoComplete="off" />
        </label>
        <label className="my-3 block flex-1 text-[15px]">Apelido
          <input className={field} value={form.lastName} onChange={update("lastName")} minLength={2} maxLength={32} required autoComplete="off" />
        </label>
      </div>
      <label className="my-3 block text-[15px]">Casa
        <select className={field} value={form.house} onChange={update("house")}>
          {HOUSES.map(house => <option key={house.value} value={house.value}>{house.label}</option>)}
        </select>
      </label>
      <div className="flex gap-4">
        <button type="submit" disabled={busy}
          className="my-3 bg-gold px-5 py-3 font-sans text-sm text-night hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-gold disabled:cursor-wait disabled:opacity-50">
          Criar personagem
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="my-3 border border-brass px-5 py-3 font-sans text-sm text-gold hover:bg-brass/20 focus:outline-2 focus:outline-offset-2 focus:outline-gold">
            Voltar
          </button>
        )}
      </div>
    </form>
  );
}

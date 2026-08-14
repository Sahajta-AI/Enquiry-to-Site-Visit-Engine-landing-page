# Enquiry-to-Site-Visit Engine — Sahajta AI Solutions

> **High-Converting Lead Intake, Automated Qualification, Live Cal.com Booking & Relational Odoo CRM Pipeline for Residential Developers.**

---

## 🌟 Overview

The **Enquiry-to-Site-Visit Engine** is an end-to-end conversion funnel built for real estate developers and sales teams. It captures high-intent buyers, qualifies them through an interactive 4-step intake wizard, embeds live strategy call scheduling via Cal.com, syncs relational lead cards into Odoo CRM, and tracks full-funnel conversion drop-offs on Meta Pixel.

---

## ✨ Key Features

- **Interactive 4-Step Intake Wizard**:
  - Step 1: Project Situation Assessment (Q1)
  - Step 2: Implementation Urgency & Timeline (Q2)
  - Step 3: Prospect Contact Details & Verification
  - Step 4: Live Cal.com Strategy Call Scheduling
- **Relational Odoo CRM Integration (`res.partner` & `crm.lead`)**:
  - 100% relational: Checks existing contacts by email in `res.partner` (Read-only).
  - Creates new Contact records when needed and links `partner_id` to `crm.lead`.
  - Posts clean HTML Log Notes to the right-side Chatter feed.
- **5-Stage Meta Pixel Conversion Funnel**:
  - Tracks `PageView`, `InitiateCheckout`, `IntakeStep1Completed`, `IntakeStep2Completed`, `Lead`, and `Schedule`.
- **Widescreen Video & Screenshot Testimonials**:
  - High-performance 2-column video player grid with full native controls (Seek bar, Volume, Fullscreen).
  - 12-card verified review screenshot proof gallery.
- **Complete Legal Suite**:
  - Privacy Policy, Terms & Conditions, Cookie Policy, Disclaimer, Support & Contact, Data Request & Deletion.

---

## 💻 Local Development Setup

1. **Clone Repository**:
   ```bash
   git clone https://github.com/saiyash07/SahajtaLandingPage.git
   cd SahajtaLandingPage
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Start Local Server**:
   ```bash
   npm start
   # or node server.js
   ```
   Open `http://localhost:3000` in your browser.

---

## ☁️ Deploying to Vercel

1. Import this repository into **Vercel** (`https://vercel.com/new`).
2. Add your **Environment Variables** in the Vercel dashboard under **Project Settings > Environment Variables**.
3. Deploy! `vercel.json` will automatically configure Serverless Express API routes (`/api/*`) and static page serving.

---

## 🛡️ License & Contact

Developed for **Sahajta AI Solution Pvt Ltd**. All rights reserved.
- Owner: Shubhang Sethi (`shubhang@sahajta.com`)

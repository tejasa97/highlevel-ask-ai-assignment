import { Fixtures, type Input } from "../../store/fixtures.js";
import { BookingPage } from "./schema.js";

declare module "../../store/fixtures.js" {
  interface Fixtures {
    bookingPage(o?: Input<BookingPage>): BookingPage;
  }
}

Fixtures.prototype.bookingPage = function (this: Fixtures, o: Input<BookingPage> = {}): BookingPage {
  const n = this.seq();
  return this.make("booking_pages", "bkp", BookingPage, {
    title: `Booking page ${n}`,
    slug: `book-${n}`,
    description: null,
    calendarId: null,
    intakeFields: [],
    confirmationMessage: null,
    redirectUrl: null,
    status: "draft",
    createdAt: this.now(),
    updatedAt: this.now(),
    publishedAt: null,
    ...o,
  });
};

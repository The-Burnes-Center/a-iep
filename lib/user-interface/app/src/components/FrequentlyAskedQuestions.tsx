import React from 'react';
import MobileTopNavigation from './MobileTopNavigation';
import AIEPFooter from './AIEPFooter';
import { Container, Row, Col, Card, Accordion} from 'react-bootstrap';
import './FrequentlyAskedQuestions.css';
import { useLanguage } from '../common/language-context';

const publicFooterLinks = [
  { route: '/', labelKey: 'footer.home' },
  { route: '/login', labelKey: 'footer.uploadIEP' },
  { route: '/faqs', labelKey: 'footer.faqs' },
  { route: '/about-the-project', labelKey: 'footer.aboutUs' },
]; 

interface FrequentlyAskedQuestionsProps {
  NavigationComponent?: React.ComponentType;
}

const FrequentlyAskedQuestions: React.FC<FrequentlyAskedQuestionsProps> = ({ 
  NavigationComponent = MobileTopNavigation 
}) => {
  // Multilingual FAQ data
  const faqsByLanguage = {
    // English (en) FAQs
    en: [
      {
        id: "0",
        question: "How do I log in?",
        answer: "When you log in, you'll receive a code by email to set a password or a one-time code for phone log ins. Only one option, either email or phone, will be active for your account."
      },
      {
        id: "1",
        question: "Do I need to end my session to erase my IEP completely?",
        answer: "The IEP is already deleted as soon as it's processed and the summary created."
      },
      {
        id: "2",
        question: "What happens to the summary of my IEP?",
        answer: "Your summary is saved securely in your account so you can come back to it anytime, even if you log out."
      },
      {
        id: "3",
        question: "Can I print my summary?",
        answer: "Yes! You can print your summary whenever you'd like."
      },
      {
        id: "4",
        question: "Who can see my IEP or summary?",
        answer: "Only you. The AIEP team cannot see your IEP, while it is being processed, or your summary."
      },
      {
        id: "5",
        question: "Is my data secure?",
        answer: "Yes. We take your privacy seriously. Your IEP file is deleted immediately after processing, and only you can see your summaries."
      },
      {
        id: "6",
        question: "Does AIEP keep my IEP file?",
        answer: "No. Your IEP file is deleted right after it's processed. The system only shows the file name so you know which document you uploaded, but the file itself is never stored. You don't need to do anything extra, your IEP is erased automatically after processing for your privacy."
      },
      {
        id: "7",
        question: "Does AIEP translate my IEP into my preferred language?",
        answer: "Not the full IEP. AIEP translates the summary of your IEP into the language you choose."
      },
      {
        id: "8",
        question: "Is the AIEP tool changing my child's IEP or their services?",
        answer: "No. The AIEP tool does not make any changes to your child's IEP or the services they receive. It only translates and summarizes the information already in the IEP to make it easier to understand."
      },
      {
        id: "9",
        question: "Can I use AIEP on my phone or tablet?",
        answer: "Yes! AIEP works on computers, phones, and tablets."
      },
      {
        id: "10",
        question: "What if I lose access to my account?",
        answer: "You can request a new login code through your registered email or phone number."
      },
      {
        id: "11",
        question: "How long will AIEP be free to use?",
        answer: "Always. AIEP is free for everyone."
      },
      {
        id: "12",
        question: "What is the difference between an IEP and a 504 Plan?",
        answer: "An Individualized Education Program (IEP) is a plan created under the Individuals with Disabilities Education Act (IDEA). It provides specialized instruction, services, and support to help a student meet their unique learning needs. A 504 Plan, on the other hand, is created under Section 504 of the Rehabilitation Act. It provides accommodations (like extra time on tests or preferential seating) so the student can access learning in the general classroom but does not include specialized instruction."
      },
      {
        id: "13",
        question: "Where can I get a copy of my child's IEP in PDF form?",
        answer: "You can request a copy directly from your child's case manager or the school's principal. They can provide you with the official PDF document and answer any questions you may have about it."
      }
    ],
    
    // Spanish (es) FAQs
    es: [
      {
        id: "0",
        question: "¿Cómo inicio sesión?",
        answer: "Cuando inicie sesión, recibirá un código por correo electrónico para establecer una contraseña o un código de un solo uso para inicios de sesión por teléfono. Solo una opción, ya sea correo electrónico o teléfono, estará activa para su cuenta."
      },
      {
        id: "1",
        question: "¿Necesito terminar mi sesión para borrar mi IEP completamente?",
        answer: "El IEP ya se elimina tan pronto como se procesa y se crea el resumen."
      },
      {
        id: "2",
        question: "¿Qué sucede con el resumen de mi IEP?",
        answer: "Su resumen se guarda de forma segura en su cuenta para que pueda volver a consultarlo en cualquier momento, incluso si cierra sesión."
      },
      {
        id: "3",
        question: "¿Puedo imprimir mi resumen?",
        answer: "¡Sí! Puede imprimir su resumen cuando lo desee."
      },
      {
        id: "4",
        question: "¿Quién puede ver mi IEP o resumen?",
        answer: "Solo usted. El equipo de AIEP no puede ver su IEP mientras se procesa, ni su resumen."
      },
      {
        id: "5",
        question: "¿Están seguros mis datos?",
        answer: "Sí. Nos tomamos su privacidad en serio. Su archivo IEP se elimina inmediatamente después del procesamiento, y solo usted puede ver sus resúmenes."
      },
      {
        id: "6",
        question: "¿AIEP guarda mi archivo IEP?",
        answer: "No. Su archivo IEP se elimina justo después de ser procesado. El sistema solo muestra el nombre del archivo para que sepa qué documento subió, pero el archivo en sí nunca se almacena. No necesita hacer nada adicional, su IEP se borra automáticamente después del procesamiento para su privacidad."
      },
      {
        id: "7",
        question: "¿AIEP traduce mi IEP a mi idioma preferido?",
        answer: "No el IEP completo. AIEP traduce el resumen de su IEP al idioma que elija."
      },
      {
        id: "8",
        question: "¿La herramienta AIEP está cambiando el IEP de mi hijo o sus servicios?",
        answer: "No. La herramienta AIEP no realiza ningún cambio en el IEP de su hijo o en los servicios que recibe. Solo traduce y resume la información que ya está en el IEP para que sea más fácil de entender."
      },
      {
        id: "9",
        question: "¿Puedo usar AIEP en mi teléfono o tableta?",
        answer: "¡Sí! AIEP funciona en computadoras, teléfonos y tabletas."
      },
      {
        id: "10",
        question: "¿Qué pasa si pierdo acceso a mi cuenta?",
        answer: "Puede solicitar un nuevo código de inicio de sesión a través de su correo electrónico o número de teléfono registrado."
      },
      {
        id: "11",
        question: "¿Por cuánto tiempo AIEP será gratuito?",
        answer: "Siempre. AIEP es gratuito para todos."
      },
      {
        id: "12",
        question: "¿Cuál es la diferencia entre un IEP y un Plan 504?",
        answer: "Un Programa de Educación Individualizado (IEP) es un plan creado bajo la Ley de Educación para Individuos con Discapacidades (IDEA). Proporciona instrucción especializada, servicios y apoyo para ayudar a un estudiante a satisfacer sus necesidades de aprendizaje únicas. Un Plan 504, por otro lado, se crea bajo la Sección 504 de la Ley de Rehabilitación. Proporciona adaptaciones (como tiempo adicional en los exámenes o asientos preferenciales) para que el estudiante pueda acceder al aprendizaje en el aula general, pero no incluye instrucción especializada."
      },
      {
        id: "13",
        question: "¿Dónde puedo obtener una copia del IEP de mi hijo en formato PDF?",
        answer: "Puede solicitar una copia directamente al administrador de casos de su hijo o al director de la escuela. Ellos pueden proporcionarle el documento PDF oficial y responder cualquier pregunta que pueda tener al respecto."
      }
    ],
    
    // Vietnamese (vi) FAQs
    vi: [
      {
        id: "0",
        question: "Làm thế nào để đăng nhập?",
        answer: "Khi đăng nhập, bạn sẽ nhận được mã qua email để đặt mật khẩu hoặc mã một lần cho đăng nhập qua điện thoại. Chỉ một tùy chọn, email hoặc điện thoại, sẽ hoạt động cho tài khoản của bạn."
      },
      {
        id: "1",
        question: "Tôi có cần kết thúc phiên làm việc để xóa hoàn toàn IEP của mình không?",
        answer: "IEP đã được xóa ngay sau khi được xử lý và bản tóm tắt được tạo."
      },
      {
        id: "2",
        question: "Điều gì xảy ra với bản tóm tắt IEP của tôi?",
        answer: "Bản tóm tắt của bạn được lưu trữ an toàn trong tài khoản để bạn có thể quay lại bất cứ lúc nào, ngay cả khi bạn đăng xuất."
      },
      {
        id: "3",
        question: "Tôi có thể in bản tóm tắt của mình không?",
        answer: "Có! Bạn có thể in bản tóm tắt của mình bất cứ khi nào bạn muốn."
      },
      {
        id: "4",
        question: "Ai có thể xem IEP hoặc bản tóm tắt của tôi?",
        answer: "Chỉ có bạn. Đội ngũ AIEP không thể xem IEP của bạn trong khi nó đang được xử lý, hoặc bản tóm tắt của bạn."
      },
      {
        id: "5",
        question: "Dữ liệu của tôi có an toàn không?",
        answer: "Có. Chúng tôi coi trọng quyền riêng tư của bạn. Tệp IEP của bạn được xóa ngay sau khi xử lý, và chỉ có bạn mới có thể xem các bản tóm tắt của mình."
      },
      {
        id: "6",
        question: "AIEP có lưu trữ tệp IEP của tôi không?",
        answer: "Không. Tệp IEP của bạn được xóa ngay sau khi được xử lý. Hệ thống chỉ hiển thị tên tệp để bạn biết tài liệu nào đã được tải lên, nhưng bản thân tệp không bao giờ được lưu trữ. Bạn không cần làm gì thêm, IEP của bạn được xóa tự động sau khi xử lý để bảo vệ quyền riêng tư của bạn."
      },
      {
        id: "7",
        question: "AIEP có dịch IEP của tôi sang ngôn ngữ ưa thích của tôi không?",
        answer: "Không phải toàn bộ IEP. AIEP dịch bản tóm tắt IEP của bạn sang ngôn ngữ bạn chọn."
      },
      {
        id: "8",
        question: "Công cụ AIEP có thay đổi IEP của con tôi hoặc các dịch vụ của chúng không?",
        answer: "Không. Công cụ AIEP không thực hiện bất kỳ thay đổi nào đối với IEP của con bạn hoặc các dịch vụ mà chúng nhận được. Nó chỉ dịch và tóm tắt thông tin đã có trong IEP để giúp dễ hiểu hơn."
      },
      {
        id: "9",
        question: "Tôi có thể sử dụng AIEP trên điện thoại hoặc máy tính bảng của mình không?",
        answer: "Có! AIEP hoạt động trên máy tính, điện thoại và máy tính bảng."
      },
      {
        id: "10",
        question: "Điều gì xảy ra nếu tôi mất quyền truy cập vào tài khoản của mình?",
        answer: "Bạn có thể yêu cầu mã đăng nhập mới thông qua email đã đăng ký hoặc số điện thoại của bạn."
      },
      {
        id: "11",
        question: "AIEP sẽ miễn phí sử dụng trong bao lâu?",
        answer: "Luôn luôn. AIEP miễn phí cho tất cả mọi người."
      },
      {
        id: "12",
        question: "Sự khác biệt giữa IEP và Kế hoạch 504 là gì?",
        answer: "Chương trình Giáo dục Cá nhân hóa (IEP) là một kế hoạch được tạo ra theo Đạo luật Giáo dục cho Cá nhân có Khuyết tật (IDEA). Nó cung cấp hướng dẫn chuyên biệt, dịch vụ và hỗ trợ để giúp học sinh đáp ứng nhu cầu học tập độc đáo của họ. Mặt khác, Kế hoạch 504 được tạo ra theo Mục 504 của Đạo luật Phục hồi. Nó cung cấp các tiện nghi (như thêm thời gian làm bài kiểm tra hoặc chỗ ngồi ưu tiên) để học sinh có thể tiếp cận học tập trong lớp học thông thường nhưng không bao gồm hướng dẫn chuyên biệt."
      },
      {
        id: "13",
        question: "Tôi có thể nhận bản sao IEP của con tôi dưới dạng PDF ở đâu?",
        answer: "Bạn có thể yêu cầu một bản sao trực tiếp từ người quản lý hồ sơ của con bạn hoặc hiệu trưởng của trường. Họ có thể cung cấp cho bạn tài liệu PDF chính thức và trả lời bất kỳ câu hỏi nào bạn có thể có về nó."
      }
    ],
    
    // Chinese (zh) FAQs
    zh: [
      {
        id: "0",
        question: "如何登录？",
        answer: "登录时，您将通过电子邮件收到一个用于设置密码的代码，或者通过电话登录的一次性代码。您的账户只有一个选项（电子邮件或电话）会处于活动状态。"
      },
      {
        id: "1",
        question: "我需要结束会话才能完全删除我的IEP吗？",
        answer: "一旦IEP被处理并创建摘要，它就已经被删除了。"
      },
      {
        id: "2",
        question: "我的IEP摘要会怎样？",
        answer: "您的摘要会安全地保存在您的账户中，即使您登出后也可以随时查看。"
      },
      {
        id: "3",
        question: "我可以打印我的摘要吗？",
        answer: "是的！您可以随时打印您的摘要。"
      },
      {
        id: "4",
        question: "谁可以看到我的IEP或摘要？",
        answer: "只有您自己。AIEP团队无法查看您的IEP（在处理过程中）或您的摘要。"
      },
      {
        id: "5",
        question: "我的数据安全吗？",
        answer: "是的。我们非常重视您的隐私。您的IEP文件在处理后立即删除，只有您可以查看您的摘要。"
      },
      {
        id: "6",
        question: "AIEP会保存我的IEP文件吗？",
        answer: "不会。您的IEP文件在处理后立即删除。系统只显示文件名，以便您知道上传了哪个文档，但文件本身从不存储。您无需做任何额外操作，为了保护您的隐私，您的IEP会在处理后自动删除。"
      },
      {
        id: "7",
        question: "AIEP是否会将我的IEP翻译成我的首选语言？",
        answer: "不是完整的IEP。AIEP将您的IEP摘要翻译成您选择的语言。"
      },
      {
        id: "8",
        question: "AIEP工具是否会更改我孩子的IEP或他们的服务？",
        answer: "不会。AIEP工具不会对您孩子的IEP或他们接受的服务进行任何更改。它只是翻译和总结IEP中已有的信息，使其更容易理解。"
      },
      {
        id: "9",
        question: "我可以在手机或平板电脑上使用AIEP吗？",
        answer: "是的！AIEP可在电脑、手机和平板电脑上使用。"
      },
      {
        id: "10",
        question: "如果我无法访问我的账户怎么办？",
        answer: "您可以通过注册的电子邮件或电话号码请求新的登录代码。"
      },
      {
        id: "11",
        question: "AIEP将免费使用多长时间？",
        answer: "永远免费。AIEP对所有人免费。"
      },
      {
        id: "12",
        question: "IEP和504计划有什么区别？",
        answer: "个别化教育计划（IEP）是根据《残疾人教育法》（IDEA）制定的计划。它提供专门的指导、服务和支持，以帮助学生满足其独特的学习需求。而504计划则是根据《康复法》第504条制定的。它提供便利（如考试额外时间或优先座位），使学生能够在普通教室中获得学习，但不包括专门指导。"
      },
      {
        id: "13",
        question: "我在哪里可以获取PDF格式的孩子IEP副本？",
        answer: "您可以直接向您孩子的案例管理员或学校校长索取。他们可以为您提供官方PDF文档，并回答您可能有的任何问题。"
      }
    ],

    // Arabic (ar) FAQs
    ar: [
      {
        id: "0",
        question: "كيف أسجّل الدخول؟",
        answer: "عند تسجيل الدخول، ستتلقى رمزًا عبر البريد الإلكتروني لتعيين كلمة مرور، أو رمزًا لمرة واحدة لتسجيل الدخول عبر الهاتف. سيكون خيار واحد فقط، إما البريد الإلكتروني أو الهاتف، مفعّلًا لحسابك."
      },
      {
        id: "1",
        question: "هل أحتاج إلى إنهاء جلستي لمحو مستند IEP نهائيًا؟",
        answer: "يُحذف مستند IEP تلقائيًا بمجرد معالجته وإنشاء الملخص."
      },
      {
        id: "2",
        question: "ماذا يحدث لملخص مستند IEP الخاص بي؟",
        answer: "يُحفظ ملخصك بأمان في حسابك حتى تتمكن من العودة إليه في أي وقت، حتى بعد تسجيل الخروج."
      },
      {
        id: "3",
        question: "هل يمكنني طباعة ملخصي؟",
        answer: "نعم! يمكنك طباعة ملخصك متى شئت."
      },
      {
        id: "4",
        question: "من يمكنه رؤية مستند IEP أو الملخص الخاص بي؟",
        answer: "أنت فقط. لا يستطيع فريق AIEP رؤية مستند IEP الخاص بك أثناء معالجته، ولا رؤية ملخصك."
      },
      {
        id: "5",
        question: "هل بياناتي آمنة؟",
        answer: "نعم. نحن نأخذ خصوصيتك على محمل الجد. يُحذف ملف IEP الخاص بك فور معالجته، وأنت وحدك من يستطيع رؤية ملخصاتك."
      },
      {
        id: "6",
        question: "هل يحتفظ AIEP بملف IEP الخاص بي؟",
        answer: "لا. يُحذف ملف IEP الخاص بك فور معالجته. يعرض النظام اسم الملف فقط لتعرف أي مستند رفعته، لكن الملف نفسه لا يُخزن أبدًا. لست بحاجة إلى فعل أي شيء إضافي؛ يُمحى مستند IEP الخاص بك تلقائيًا بعد المعالجة حفاظًا على خصوصيتك."
      },
      {
        id: "7",
        question: "هل يترجم AIEP مستند IEP الخاص بي إلى لغتي المفضلة؟",
        answer: "ليس المستند كاملًا. يترجم AIEP ملخص مستند IEP الخاص بك إلى اللغة التي تختارها."
      },
      {
        id: "8",
        question: "هل تُغيّر أداة AIEP مستند IEP الخاص بطفلي أو الخدمات المقدمة له؟",
        answer: "لا. لا تُجري أداة AIEP أي تغييرات على مستند IEP الخاص بطفلك أو الخدمات التي يتلقاها. هي فقط تترجم وتلخّص المعلومات الموجودة أصلًا في المستند لتسهيل فهمها."
      },
      {
        id: "9",
        question: "هل يمكنني استخدام AIEP على هاتفي أو جهازي اللوحي؟",
        answer: "نعم! يعمل AIEP على أجهزة الكمبيوتر والهواتف والأجهزة اللوحية."
      },
      {
        id: "10",
        question: "ماذا لو فقدت الوصول إلى حسابي؟",
        answer: "يمكنك طلب رمز دخول جديد عبر بريدك الإلكتروني أو رقم هاتفك المسجّل."
      },
      {
        id: "11",
        question: "إلى متى سيبقى استخدام AIEP مجانيًا؟",
        answer: "دائمًا. AIEP مجاني للجميع."
      },
      {
        id: "12",
        question: "ما الفرق بين IEP وخطة 504؟",
        answer: "برنامج التعليم الفردي (IEP) هو خطة تُوضع بموجب قانون تعليم الأفراد ذوي الإعاقة (IDEA)، وتوفر تعليمًا متخصصًا وخدمات ودعمًا لمساعدة الطالب على تلبية احتياجاته التعليمية الفريدة. أما خطة 504 فتُوضع بموجب المادة 504 من قانون إعادة التأهيل، وتوفر تيسيرات (مثل وقت إضافي في الاختبارات أو مقعد مناسب في الصف) ليتمكن الطالب من الوصول إلى التعلم في الصف العام، لكنها لا تشمل تعليمًا متخصصًا."
      },
      {
        id: "13",
        question: "أين يمكنني الحصول على نسخة من مستند IEP الخاص بطفلي بصيغة PDF؟",
        answer: "يمكنك طلب نسخة مباشرة من مدير حالة طفلك أو من مدير المدرسة. يمكنهم تزويدك بالمستند الرسمي بصيغة PDF والإجابة عن أي أسئلة لديك حوله."
      }
    ]
  };

  const { language } = useLanguage();
  
  // Use the selected language or fallback to English if the language is not supported
  const displayFaqs = faqsByLanguage[language] || faqsByLanguage['en'];

  // Get appropriate heading text based on language
  const getFaqHeaderText = () => {
    switch(language) {
      case 'es':
        return 'Preguntas Frecuentes';
      case 'vi':
        return 'Câu Hỏi Thường Gặp';
      case 'zh':
        return '常见问题';
      case 'ar':
        return 'الأسئلة الشائعة';
      default:
        return 'Frequently Asked Questions';
    }
  };

  return (
    <>
      <NavigationComponent />
      <Container className="faqs-container mt-3 mb-3">
        <Row className="mt-2">
          <Col>
            <Card className="faqs-card">
              <Row className="g-0">
                <Col md={12} className="no-padding-inherit-faq">
                  <>
                    <h4 className="faqs-header mt-4 px-4">{getFaqHeaderText()}</h4>
                    <Accordion defaultActiveKey={null} className="mb-3 faqs-accordion">
                      {displayFaqs.map((faq) => (
                        <Accordion.Item key={faq.id} eventKey={faq.id}>
                          <Accordion.Header>
                            {faq.question}
                          </Accordion.Header>
                          <Accordion.Body>
                            <div className="faq-content">
                              {faq.answer}
                            </div>
                          </Accordion.Body>
                        </Accordion.Item>
                      ))}
                    </Accordion>
                  </>
                </Col>
              </Row>
            </Card>
          </Col>
        </Row>
      </Container>
      <AIEPFooter footerLinks={publicFooterLinks} />
    </>
  );
};

export default FrequentlyAskedQuestions;